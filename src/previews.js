// Лёгкие копии оригиналов (фото, присланных файлом): JPEG до 2560 px, чтобы они открывались так же
// быстро, как обычные фото. Делает их сам телефон — сервер на бесплатном тарифе не умеет читать HEIC.
//   • просмотр: оригинал только что открыли, он уже скачан — копия из него (fromImage);
//   • фон: при запуске галерея сама проходит по оригиналам без копии, по одному (Backfill).
import { PREVIEW_FROM } from './upload.js';
import { isAbort, sleep } from './api.js';

const SIDE = 2560;
const MAX_ORIG = 20 * 1024 * 1024; // больше 20 МБ Telegram боту не отдаёт — копию не сделать
const busy = new Set(); // оригиналы, для которых копия уже готовится (общий список на всё приложение)
const failed = new Set(); // телефон не смог их прочитать (например, HEIC на Android) — больше не пробуем

export const needsPreview = (it) => it.k === 'd' && !it.v && !it.vp && !failed.has(it.p) && !(it.s && (it.s < PREVIEW_FROM || it.s > MAX_ORIG));

async function toJpeg(img) {
  const k = Math.min(1, SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  c.width = c.height = 0; // сразу отдаём память (на iPhone её у веб-страницы немного)
  return blob;
}

async function send(disk, it, img) {
  const blob = await toJpeg(img);
  if (!blob) return;
  const saved = await disk.savePreview(it, blob, img.naturalWidth, img.naturalHeight);
  // Флаг v придёт со списком фото при следующем полном обновлении, а пока помечаем у себя.
  it.vp = 1;
  if (saved?.w && !it.w) Object.assign(it, { w: saved.w, h: saved.h });
}

// Оригинал уже открыт в просмотре (img раскодирован) — делаем копию из него.
export function fromImage(disk, it, img, onDone) {
  if (!disk.savePreview || !needsPreview(it) || busy.has(it.p) || !img.naturalWidth) return;
  busy.add(it.p);
  setTimeout(async () => {
    try {
      await send(disk, it, img);
      onDone?.(it);
    } catch {
      // Не вышло (нет сети, Telegram занят) — попробуем ещё раз позже.
    } finally {
      busy.delete(it.p);
    }
  }, 400);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => resolve(img));
    img.onerror = () => reject(new Error('undecodable'));
    img.src = url;
  });
}

// Фоновая очередь: по одному фото, только пока галерея на экране, с паузами — чтобы не мешать
// загрузке миниатюр и не упираться в ограничения Telegram.
export class Backfill {
  constructor({ disk, onDone }) {
    this.disk = disk;
    this.onDone = onDone;
    this.queue = [];
    this.tries = new Map();
    this.running = false;
  }

  setItems(items) {
    if (!this.disk.savePreview || !this.disk.previewBlob) return;
    // Сначала самые новые: их скорее всего и откроют.
    this.queue = items.filter(needsPreview).sort((a, b) => b.t - a.t);
    if (this.queue.length && !this.running) this.run();
  }

  async run() {
    this.running = true;
    await sleep(3000); // сначала пусть загрузятся миниатюры на экране
    while (this.queue.length) {
      if (document.visibilityState !== 'visible') {
        await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
        continue;
      }
      const it = this.queue.shift();
      if (!needsPreview(it) || busy.has(it.p)) continue;
      busy.add(it.p);
      let url = null;
      try {
        // Оригинал — по адресу «orig», а не «large»: иначе браузер запомнил бы оригинал под адресом,
        // по которому просмотр потом будет брать лёгкую копию.
        url = URL.createObjectURL(await this.disk.previewBlob(it, 'orig'));
        let img;
        try {
          img = await loadImage(url);
        } catch {
          failed.add(it.p);
          continue;
        }
        await send(this.disk, it, img);
        this.onDone?.(it);
        await sleep(1500);
      } catch (e) {
        if (isAbort(e)) break;
        // Telegram просит подождать или пропала сеть — пауза, и это фото — в конец очереди (не больше 3 раз).
        const n = (this.tries.get(it.p) || 0) + 1;
        this.tries.set(it.p, n);
        if (n < 3) this.queue.push(it);
        else failed.add(it.p);
        await sleep(((e?.retry_after || 0) + 20) * 1000);
      } finally {
        if (url) URL.revokeObjectURL(url);
        busy.delete(it.p);
      }
    }
    this.running = false;
  }
}
