// Загрузка фото из приложения: выбор файлов, подготовка и очередь отправки.
//
// «Обычное качество» — фото уменьшаются до 2560 px (Telegram всё равно сжал бы их до этого размера)
// и отправляются как фото. «Оригинал» — файл уходит как есть (документом), с маленькой обложкой для галереи.
// Отправляем альбомами до 10 фото. Если Telegram просит подождать — ждём столько, сколько он сказал.
import { haptic, pushBack } from './tg.js';
import { sleep, isAbort } from './api.js';
import { photoMeta } from './exif.js';

const BATCH = 10;
const BATCH_BYTES = 40 * 1024 * 1024; // запрос к серверу — до 100 МБ; берём с запасом
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_DOC = 50 * 1024 * 1024;
const PHOTO_SIDE = 2560;
const THUMB_SIDE = 320;
const MODE_KEY = 'upload-mode';

export const getMode = () => (localStorage.getItem(MODE_KEY) === 'doc' ? 'doc' : 'photo');
const setMode = (m) => localStorage.setItem(MODE_KEY, m);

// ── Шторка «Загрузить» ──
export function showUploadSheet({ onFiles }) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `
    <div class="sheet-bg"></div>
    <div class="sheet">
      <div class="sheet-head"><div class="sheet-grab"></div><h2>Загрузить фото</h2><button class="text-btn done">Отмена</button></div>
      <div class="group-title">Качество</div>
      <div class="quality">
        <button data-mode="photo"><b>Обычное</b><span>Как присылает Telegram: до 2560 px. Быстро и экономно.</span></button>
        <button data-mode="doc"><b>Оригинал</b><span>Файл без сжатия, до 50 МБ. Смотреть в галерее можно файлы до 20 МБ.</span></button>
      </div>
      <button class="big-btn" id="pick">Выбрать фото</button>
      <div class="setup-hint">Фото появятся в вашем чате с ботом. Не закрывайте приложение, пока идёт загрузка.</div>
      <input type="file" accept="image/*" multiple hidden>
    </div>`;
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const q = (s) => wrap.querySelector(s);
  let mode = getMode();
  const paint = () => wrap.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  paint();

  let popBack = () => {};
  const close = () => {
    popBack();
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 350);
  };
  popBack = pushBack(close);
  q('.sheet-bg').addEventListener('click', close);
  q('.done').addEventListener('click', close);
  q('.quality').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    setMode(mode);
    paint();
    haptic('select');
  });
  const input = q('input');
  q('#pick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...input.files];
    close();
    if (files.length) onFiles(files, mode);
  });
}

// ── Подготовка файла ──
async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    return null; // например, HEIC в Android — браузер его не понимает
  }
}

function toJpeg(bmp, side, quality) {
  const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}

const baseName = (n) => (n || 'photo').replace(/\.[^.]+$/, '');

// Возвращает { mode, file, thumb, meta } или бросает ошибку с понятным текстом.
async function prepare(file, mode) {
  // Дату и место читаем до уменьшения: при перекодировании в JPEG (и в Telegram) они стираются.
  const ex = await photoMeta(file);
  const taken = ex.taken || file.lastModified || Date.now();
  const geo = ex.la != null ? { la: ex.la, lo: ex.lo } : {};
  if (mode === 'photo') {
    const bmp = await decode(file);
    if (bmp) {
      const blob = await toJpeg(bmp, PHOTO_SIDE, 0.9);
      const meta = { taken, w: bmp.width, h: bmp.height, ...geo };
      bmp.close();
      if (blob && blob.size <= MAX_PHOTO) return { mode, file: new File([blob], baseName(file.name) + '.jpg', { type: 'image/jpeg' }), meta };
    }
    // Не получилось уменьшить — отправим как есть: фото, если Telegram такое примет, иначе файлом.
    if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size <= MAX_PHOTO) return { mode, file, meta: { taken, ...geo } };
    mode = 'doc';
  }
  if (file.size > MAX_DOC) throw new Error(`«${file.name}» больше 50 МБ — Telegram такие файлы от ботов не принимает`);
  const bmp = await decode(file);
  let thumb = null;
  const meta = { taken, ...geo };
  if (bmp) {
    meta.w = bmp.width;
    meta.h = bmp.height;
    const t = await toJpeg(bmp, THUMB_SIDE, 0.8);
    bmp.close();
    if (t && t.size <= 200 * 1024) thumb = t;
  }
  return { mode: 'doc', file, thumb, meta };
}

// ── Очередь ──
export class Uploader {
  constructor({ api, onItems, onState, toast }) {
    this.api = api;
    this.onItems = onItems;
    this.onState = onState;
    this.toast = toast;
    this.queue = [];
    this.running = false;
    this.stats = { done: 0, total: 0, skipped: 0, failed: 0 };
  }

  add(files, mode) {
    for (const f of files) this.queue.push({ f, mode });
    this.stats.total += files.length;
    haptic('light');
    this.paint(0);
    if (!this.running) this.run();
  }

  paint(partial) {
    const { done, total } = this.stats;
    this.onState({ text: `Загрузка: ${Math.min(total, done + 1).toLocaleString('ru')} из ${total.toLocaleString('ru')}`, progress: total ? (done + partial) / total : 0 });
  }

  // Берём из очереди следующую пачку: до 10 фото одного вида и не больше 40 МБ.
  async nextBatch() {
    const batch = [];
    let bytes = 0;
    while (this.queue.length && batch.length < BATCH) {
      const { f, mode } = this.queue[0];
      let p;
      try {
        p = await prepare(f, mode);
      } catch (e) {
        this.queue.shift();
        this.stats.failed++;
        this.stats.done++;
        this.toast(e.message);
        continue;
      }
      const size = p.file.size + (p.thumb?.size || 0);
      if (batch.length && (p.mode !== batch[0].mode || bytes + size > BATCH_BYTES)) break;
      this.queue.shift();
      batch.push(p);
      bytes += size;
    }
    return batch;
  }

  async run() {
    this.running = true;
    try {
      for (;;) {
        const batch = await this.nextBatch();
        if (!batch.length) break;
        await this.send(batch);
        if (this.stop) break;
        if (this.queue.length) await sleep(1000); // Telegram не любит, когда в один чат пишут слишком часто
      }
    } finally {
      this.running = false;
      this.finish();
    }
  }

  async send(batch) {
    const form = new FormData();
    form.set('mode', batch[0].mode);
    form.set('meta', JSON.stringify(batch.map((p) => p.meta)));
    batch.forEach((p, i) => {
      form.set('f' + i, p.file, p.file.name);
      if (p.thumb) form.set('t' + i, p.thumb, `t${i}.jpg`);
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.api.upload(form, { onProgress: (loaded, total) => this.paint((loaded / total) * batch.length * 0.95) });
        this.stats.done += batch.length;
        this.stats.skipped += res.skipped || 0;
        if (res.items?.length) this.onItems(res.items);
        this.paint(0);
        return;
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e.code === 'rate') {
          this.onState({ text: `Telegram просит подождать ${e.retry_after} с…`, progress: this.stats.done / this.stats.total });
          await sleep((e.retry_after || 5) * 1000 + 500);
          continue;
        }
        if (['start_bot', 'expired', 'auth', 'forbidden'].includes(e.code)) {
          this.toast(e.message);
          this.stats.failed += batch.length + this.queue.length;
          this.queue.length = 0;
          this.stop = true;
          return;
        }
        if (attempt < 2 && (e.status === 0 || e.status >= 500)) {
          await sleep(3000 * (attempt + 1));
          continue;
        }
        this.toast(e.message || 'Не удалось загрузить');
        this.stats.failed += batch.length;
        this.stats.done += batch.length;
        return;
      }
    }
  }

  finish() {
    const { done, skipped, failed } = this.stats;
    const ok = done - failed - skipped;
    this.onState(null);
    if (ok > 0 || skipped > 0) {
      let t = ok > 0 ? `Загружено: ${ok.toLocaleString('ru')}` : 'Новых фото нет';
      if (skipped) t += ` · уже были: ${skipped}`;
      if (failed) t += ` · не вышло: ${failed}`;
      this.toast(t);
      haptic('medium');
    }
    this.stats = { done: 0, total: 0, skipped: 0, failed: 0 };
    this.stop = false;
  }
}
