// Фоновый анализ фото прямо на устройстве: вектор «смысла» (CLIP) для поиска и лица для «Людей».
// Ничего не отправляется наружу — из сети скачиваются только сами модели (один раз).
// Результаты лежат в IndexedDB; анализ продолжается с места остановки при следующем открытии.
import { createStore, entries, setMany, clear } from 'idb-keyval';
import { PreviewLoader } from '../loader.js';
import { detectFaces, loadFaces } from './faces.js';
import { pack, unpack, dotPacked, dot, normalized } from './vec.js';

const FACE_T = 0.64; // порог «тот же человек» (калибровка: свой 0.66–0.92, чужие ≤ 0.51, родственники до 0.63)
const MIN_PHOTOS_FOR_PERSON = 3;
const MAX_SIDE = 640;

// ── Компактное хранение векторов: int8 + масштаб ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Обёртка над фоновым потоком CLIP ──
class Clip {
  constructor(onProgress) {
    this.worker = new Worker(new URL('./clip-worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress' || data.type === 'ready') return onProgress(data);
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
  }
  call(type, data = {}, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...data }, transfer);
    });
  }
}

// Пользователь листает/тапает — не мешаем ему, анализ подождёт.
let lastTouch = 0;
for (const ev of ['touchstart', 'touchmove', 'wheel', 'pointerdown', 'keydown']) {
  addEventListener(ev, () => (lastTouch = performance.now()), { passive: true, capture: true });
}

export class Indexer extends EventTarget {
  constructor({ ns, disk, store }) {
    super();
    this.ns = ns;
    this.photosDb = createStore(`ml-${ns}-photos`, 'kv');
    this.peopleDb = createStore(`ml-${ns}-clusters`, 'kv');
    this.loader = new PreviewLoader(disk, store, { concurrency: 2, persist: true, memLimit: 6 });
    this.recs = new Map(); // path -> { c: packed|null, f: [{ b, k, e: packed }] }
    this.clusters = new Map(); // id -> { sum: Float32Array, norm: Float32Array, n, cover: { p, b, a } }
    this.names = JSON.parse(localStorage.getItem(this.namesKey) || '{}');
    this.items = [];
    this.byPath = new Map();
    this.state = 'off';
    this.error = '';
    this.models = { vision: 0, text: 0 }; // прогресс загрузки моделей 0..1
    this.ready = this.loadFromDb();
    document.addEventListener('visibilitychange', () => document.hidden || this.kick());
    addEventListener('online', () => this.kick());
  }

  get enabledKey() {
    return `ml-enabled-${this.ns}`;
  }
  get namesKey() {
    return `people-names-${this.ns}`;
  }
  get enabled() {
    return localStorage.getItem(this.enabledKey) === '1';
  }

  async loadFromDb() {
    try {
      for (const [p, r] of await entries(this.photosDb)) this.recs.set(p, r);
      let maxId = 0;
      for (const [id, c] of await entries(this.peopleDb)) {
        this.clusters.set(id, { ...c, norm: normalized(c.sum) });
        maxId = Math.max(maxId, id);
      }
      this.nextId = maxId + 1;
    } catch (e) {
      console.warn('ml db', e);
      this.nextId = 1;
    }
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get total() {
    return this.items.length;
  }
  get done() {
    let n = 0;
    for (const it of this.items) if (this.recs.has(it.p)) n++;
    return n;
  }

  setItems(items) {
    this.items = items;
    this.byPath = new Map(items.map((it) => [it.p, it]));
    this.kick();
    this.emit('update');
  }

  enable() {
    localStorage.setItem(this.enabledKey, '1');
    this.kick();
    this.emit('progress');
  }

  // Остановить анализ, не удаляя результаты (например, когда доступ к Диску пропал).
  stop() {
    this.stopped = true;
    this.stopRequested = true;
    clearTimeout(this.retryT);
  }

  async disable() {
    localStorage.removeItem(this.enabledKey);
    clearTimeout(this.retryT);
    this.stopRequested = true;
    this.state = 'off';
    this.recs.clear();
    this.clusters.clear();
    this.nextId = 1;
    await clear(this.photosDb);
    await clear(this.peopleDb);
    this.emit('progress');
    this.emit('update');
  }

  kick() {
    if (!this.enabled || this.running || this.stopped || !this.items.length) return;
    this.run();
  }

  setState(s, error = '') {
    this.state = s;
    this.error = error;
    this.emit('progress');
  }

  onModelProgress(d) {
    if (d.type === 'ready') this.models[d.model] = 1;
    else this.models[d.model] = d.total ? d.loaded / d.total : 0;
    this.emit('progress');
  }

  get clip() {
    return (this._clip ||= new Clip((d) => this.onModelProgress(d)));
  }

  async run() {
    this.running = true;
    this.stopRequested = false;
    try {
      await this.ready;
      this.setState('loading');
      await Promise.all([this.clip.call('loadVision'), loadFaces().catch((e) => (this.facesError = e.message))]);
      this.setState('running');
      let sinceSave = 0;
      let dirtyPhotos = [];
      const dirtyClusters = new Set();
      const flush = async () => {
        if (!dirtyPhotos.length && !dirtyClusters.size) return;
        const photos = dirtyPhotos;
        dirtyPhotos = [];
        const cl = [...dirtyClusters].map((id) => {
          const { sum, n, cover } = this.clusters.get(id);
          return [id, { sum, n, cover }];
        });
        dirtyClusters.clear();
        await setMany(photos, this.photosDb);
        await setMany(cl, this.peopleDb);
        this.emit('update');
      };

      while (!this.stopRequested) {
        // Сначала самые свежие фото.
        let next = null;
        for (let i = this.items.length - 1; i >= 0; i--) {
          if (!this.recs.has(this.items[i].p)) {
            next = this.items[i];
            break;
          }
        }
        if (!next) break;
        if (document.hidden) {
          await flush();
          this.setState('paused');
          this.running = false;
          return;
        }
        while (performance.now() - lastTouch < 1200) await sleep(300);

        let rec;
        try {
          rec = await this.analyze(next, dirtyClusters);
        } catch (e) {
          if (e?.name === 'AbortError') continue;
          console.warn('analyze failed', next.p, e);
          // Нет сети, сервер недоступен или вход устарел — не помечаем фото как «готово»,
          // а ставим анализ на паузу и пробуем позже. Пропускаем только файлы, которые не открыть.
          if (!(e?.status === 404 || e?.decode)) {
            await flush();
            this.setState('error', 'Нет связи с сервером — продолжу позже');
            this.running = false;
            clearTimeout(this.retryT);
            this.retryT = setTimeout(() => this.kick(), 60000);
            return;
          }
          rec = { c: null, f: [], err: 1 };
        }
        if (this.stopRequested) break;
        this.recs.set(next.p, rec);
        dirtyPhotos.push([next.p, rec]);
        if (++sinceSave >= 12) {
          sinceSave = 0;
          await flush();
        }
        this.emit('progress');
        await sleep(15);
      }
      await flush();
      this.setState(this.stopRequested ? 'off' : 'done');
    } catch (e) {
      console.warn('indexer', e);
      this.setState('error', e.message || 'Ошибка анализа');
    } finally {
      this.running = false;
      // Выключили и сразу включили снова, пока шёл анализ, — продолжаем.
      if (this.stopRequested && this.enabled && !this.stopped) queueMicrotask(() => this.kick());
    }
  }

  async analyze(item, dirtyClusters) {
    const job = this.loader.load(item, 'L');
    const url = await job.promise;
    let bmp;
    try {
      bmp = await createImageBitmap(await (await fetch(url)).blob());
    } catch (e) {
      e.decode = true; // битый или неподдерживаемый файл — пропустим его
      throw e;
    }
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const [faces, vec] = await Promise.all([
      this.facesError ? [] : detectFaces(canvas).catch(() => []),
      this.clip.call('embedImage', { pixels: px.data.buffer, width: px.width, height: px.height }, [px.data.buffer]),
    ]);
    const f = faces.map((face) => {
      const id = this.assign(face, item.p);
      dirtyClusters.add(id);
      return { b: face.b, k: id, e: pack(face.e) };
    });
    return { c: pack(vec), f };
  }

  // Относим лицо к ближайшему человеку или заводим нового.
  assign(face, path) {
    let best = -1;
    let bestId = 0;
    for (const [id, c] of this.clusters) {
      const s = dot(c.norm, face.e);
      if (s > best) {
        best = s;
        bestId = id;
      }
    }
    const area = face.b[2] * face.b[3] * face.s;
    if (best >= FACE_T) {
      const c = this.clusters.get(bestId);
      for (let i = 0; i < c.sum.length; i++) c.sum[i] += face.e[i];
      c.norm = normalized(c.sum);
      c.n++;
      if (area > c.cover.a) c.cover = { p: path, b: face.b, a: area };
      return bestId;
    }
    const id = this.nextId++;
    this.clusters.set(id, { sum: Float32Array.from(face.e), norm: face.e, n: 1, cover: { p: path, b: face.b, a: area } });
    return id;
  }

  // ── Люди ──
  people() {
    const photos = new Map(); // clusterId -> Set(path)
    for (const it of this.items) {
      const r = this.recs.get(it.p);
      if (!r) continue;
      for (const f of r.f) {
        if (!photos.has(f.k)) photos.set(f.k, new Set());
        photos.get(f.k).add(it.p);
      }
    }
    // Одинаковые имена = один человек (так пользователь сам объединяет «распавшегося» человека).
    const groups = new Map();
    for (const [id, set] of photos) {
      const name = (this.names[id] || '').trim();
      const key = name ? 'n:' + name.toLowerCase() : 'c:' + id;
      if (!groups.has(key)) groups.set(key, { key, name, ids: [], paths: new Set() });
      const g = groups.get(key);
      g.ids.push(id);
      for (const p of set) g.paths.add(p);
    }
    const out = [];
    for (const g of groups.values()) {
      if (!g.name && g.paths.size < MIN_PHOTOS_FOR_PERSON) continue;
      const coverCluster = g.ids.map((id) => this.clusters.get(id)).filter(Boolean).sort((a, b) => b.n - a.n)[0];
      const coverItem = coverCluster && this.byPath.get(coverCluster.cover.p);
      out.push({
        key: g.key,
        ids: g.ids,
        name: g.name,
        items: this.items.filter((it) => g.paths.has(it.p)),
        cover: coverItem ? { item: coverItem, b: coverCluster.cover.b } : null,
      });
    }
    return out.sort((a, b) => !!b.name - !!a.name || b.items.length - a.items.length);
  }

  rename(ids, name) {
    for (const id of ids) {
      if (name.trim()) this.names[id] = name.trim();
      else delete this.names[id];
    }
    localStorage.setItem(this.namesKey, JSON.stringify(this.names));
    this.emit('update');
  }

  findPerson(query) {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return this.people().find((p) => p.name && p.name.toLowerCase().startsWith(q)) || null;
  }

  // ── Поиск по смыслу ──
  get indexedCount() {
    let n = 0;
    for (const it of this.items) if (this.recs.get(it.p)?.c) n++;
    return n;
  }

  async semantic(text, candidates) {
    const te = await this.clip.call('embedText', { text });
    const scored = [];
    for (const it of candidates) {
      const r = this.recs.get(it.p);
      if (r?.c) scored.push([it, dotPacked(r.c, te)]);
    }
    if (!scored.length) return [];
    let mean = 0;
    for (const [, s] of scored) mean += s;
    mean /= scored.length;
    let v = 0;
    for (const [, s] of scored) v += (s - mean) ** 2;
    const sd = Math.sqrt(v / scored.length) || 0.01;
    // Берём заметно выделяющиеся по сходству (относительно всей библиотеки), но не больше 400.
    const cut = Math.max(mean + 1.9 * sd, 0.215);
    const hits = scored.filter(([, s]) => s >= cut).sort((a, b) => b[1] - a[1]).slice(0, 400);
    return hits.map(([it]) => it).sort((a, b) => a.t - b.t);
  }

  loadTextModel() {
    return this.clip.call('loadText');
  }
}

export { unpack };
