// Демо-медиатека без Telegram и сервера: http://localhost:5173/?mock
// «Загрузка» и автозагрузка в демо работают понарошку: выбранные фото видны только до перезагрузки.
// Только для режима разработки — в рабочую сборку этот файл не попадает.
// Фото — бесплатные снимки с Unsplash через сервис picsum.photos.

const DAY = 86400000;
const SIZES = { S: 150, M: 300, L: 500, XL: 800, XXL: 1024, XXXL: 1280 };

// Простой предсказуемый генератор случайных чисел: при каждом запуске одна и та же «медиатека».
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export class MockDisk {
  constructor() {
    this.kind = 'mock';
    this.local = new Map(); // номер → файл, «загруженный» в демо
    this.nextId = 100000;
    this.key = null;
  }

  async me() {
    return { uid: '', name: 'Демо', total: 0, used: 0 };
  }

  async listAll(onProgress) {
    const list = [];
    for (let page = 1; page <= 4; page++) {
      const r = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=100`);
      list.push(...(await r.json()));
      onProgress?.(list.length);
    }
    const rand = rng(7);
    // Перемешиваем: у picsum первые снимки — сплошь ноутбуки.
    for (let j = list.length - 1; j > 0; j--) {
      const r = Math.floor(rand() * (j + 1));
      [list[j], list[r]] = [list[r], list[j]];
    }
    const now = new Date();
    now.setHours(18, 0, 0, 0);
    const trips = [
      { name: 'Сочи 2025', la: 43.58, lo: 39.72, from: 140, days: 20 },
      { name: 'Стамбул', la: 41.01, lo: 28.97, from: 520, days: 12 },
    ];
    const items = [];
    let day = 0;
    let i = 0;
    while (i < list.length) {
      const n = 2 + Math.floor(rand() * 8);
      const trip = trips.find((t) => day >= t.from && day < t.from + t.days);
      for (let k = 0; k < n && i < list.length; k++, i++) {
        const p = list[i];
        const t = now.getTime() - day * DAY - Math.floor(rand() * 10) * 3600000 - k * 120000;
        const folder = trip ? `Отпуск/${trip.name}` : rand() < 0.12 ? 'Семья' : 'Фотокамера';
        const name = `IMG_${String(4000 + i).padStart(4, '0')}.jpg`;
        // В u храним номер снимка на picsum и его размеры (список фото кэшируется между запусками)
        const it = { p: `disk:/${folder}/${name}`, n: name, u: `${p.id}:${p.width}:${p.height}`, t, s: 1500000 + Math.floor(rand() * 3000000) };
        if (i % 7 === 0) it.k = 'd'; // каждое седьмое — «оригинал файлом»
        if (trip) Object.assign(it, { la: trip.la + rand() * 0.05, lo: trip.lo + rand() * 0.05 });
        else if (rand() < 0.6) Object.assign(it, { la: 55.75 + rand() * 0.05, lo: 37.6 + rand() * 0.05 });
        items.push(it);
      }
      day += 1 + Math.floor(rand() * (day < 30 ? 3 : 28)); // снимки за несколько лет
    }
    return items;
  }

  async recent() {
    return [];
  }

  url(item, size) {
    const [id, w, h] = item.u.split(':');
    const ph = { id, w: +w, h: +h };
    const side = SIZES[size] || 500;
    const k = side / Math.max(ph.w, ph.h);
    return `https://picsum.photos/id/${ph.id}/${Math.round(ph.w * k)}/${Math.round(ph.h * k)}`;
  }

  async previewBlob(item, size, signal) {
    if (this.local.has(item.i)) return this.local.get(item.i);
    const r = await fetch(this.url(item, size), { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }

  async upload(form, { onProgress } = {}) {
    const meta = JSON.parse(form.get('meta') || '[]');
    const items = [];
    for (let i = 0; form.get('f' + i); i++) {
      const f = form.get('f' + i);
      for (let k = 1; k <= 5; k++) {
        await new Promise((r) => setTimeout(r, 120));
        onProgress?.(i * 5 + k, 50);
      }
      const id = ++this.nextId;
      this.local.set(id, f);
      const m = meta[i] || {};
      items.push({ i: id, t: m.taken || Date.now(), w: m.w, h: m.h, la: m.la, lo: m.lo, k: form.get('mode') === 'doc' ? 'd' : 'p', s: f.size, n: f.name, o: 'app' });
    }
    return { ok: true, items, skipped: 0 };
  }

  async deletePhoto(item) {
    this.local.delete(item.i);
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, chat: 'deleted' };
  }

  // Лёгкая копия оригинала — в демо просто запоминаем, что её «отправили».
  async savePreview(item, blob, w, h) {
    (this.previews ||= []).push({ p: item.p, size: blob.size, w, h });
    return { i: item.i, k: 'd', v: 1, w, h };
  }

  async autoKeyInfo() {
    return { exists: Boolean(this.key), created: this.key?.created, used: null, cursor: null, base: 'https://tg-photo-bot.example.workers.dev', archive: this.key ? { count: 3200, cursor: Date.UTC(2019, 2, 14), used: Date.now() - 600000, done: false } : null };
  }
  async createAutoKey() {
    const base = 'https://tg-photo-bot.example.workers.dev';
    this.key = { created: Date.now() };
    return { key: 'tgp_DEMO' + 'x'.repeat(28), base, uploadUrl: base + '/api/upload', sinceUrl: base + '/api/auto/since' };
  }
  async deleteAutoKey() {
    this.key = null;
    return { ok: true };
  }

  async originalUrl(item) {
    if (this.local.has(item.i)) return URL.createObjectURL(this.local.get(item.i));
    return this.url(item, 'XXXL');
  }
}
