// Демо-режим без Telegram и без сервера: http://localhost:5173/?mock (только при `npm run dev`).
// Фото — бесплатные снимки с Unsplash через picsum.photos. Загрузка работает «понарошку»:
// выбранные фото показываются в галерее, но никуда не отправляются.
import { sleep } from './api.js';

const DAY = 86400000;
const SIDE = { thumb: 320, medium: 800, large: 1600, orig: 2000 };

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export class MockApi {
  constructor() {
    this.kind = 'mock';
    this.local = new Map(); // i -> blob выбранных при «загрузке» фото
    this.nextId = 100000;
    this.key = null;
  }

  async list(after = 0, onProgress) {
    if (after) return [];
    const list = [];
    for (let page = 1; page <= 3; page++) {
      const r = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=100`);
      list.push(...(await r.json()));
      onProgress?.(list.length);
    }
    const rand = rng(11);
    for (let j = list.length - 1; j > 0; j--) {
      const r = Math.floor(rand() * (j + 1));
      [list[j], list[r]] = [list[r], list[j]];
    }
    const now = new Date();
    now.setHours(18, 0, 0, 0);
    const items = [];
    let day = 0;
    let i = 0;
    while (i < list.length) {
      const n = 2 + Math.floor(rand() * 7);
      for (let k = 0; k < n && i < list.length; k++, i++) {
        const p = list[i];
        const doc = rand() < 0.15;
        items.push({ i: i + 1, t: now.getTime() - day * DAY - Math.floor(rand() * 10) * 3600000 - k * 120000, w: p.width, h: p.height, k: doc ? 'd' : 'p', s: doc ? 3e6 + rand() * 5e6 : 4e5 + rand() * 6e5, n: doc ? `IMG_${4000 + i}.HEIC` : undefined, _pic: p.id });
      }
      day += 1 + Math.floor(rand() * (day < 30 ? 3 : 25));
    }
    return items;
  }

  refreshToken() {}

  fileUrl(item, size) {
    if (this.local.has(item.i)) return URL.createObjectURL(this.local.get(item.i));
    const k = (SIDE[size] || 800) / Math.max(item.w, item.h);
    return `https://picsum.photos/id/${item._pic}/${Math.round(item.w * k)}/${Math.round(item.h * k)}`;
  }

  async previewBlob(item, size, signal) {
    if (this.local.has(item.i)) return this.local.get(item.i);
    const r = await fetch(this.fileUrl(item, size), { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }

  async upload(form, { onProgress } = {}) {
    const items = [];
    for (let i = 0; form.get('f' + i); i++) {
      const f = form.get('f' + i);
      const meta = JSON.parse(form.get('meta') || '[]')[i] || {};
      for (let p = 1; p <= 5; p++) {
        await sleep(120);
        onProgress?.(((i + p / 5) / 10) * 100, 100);
      }
      const id = ++this.nextId;
      this.local.set(id, f);
      items.push({ i: id, t: meta.taken || Date.now(), w: meta.w, h: meta.h, k: form.get('mode') === 'doc' ? 'd' : 'p', s: f.size, n: form.get('mode') === 'doc' ? f.name : undefined });
    }
    return { ok: true, items, skipped: 0 };
  }

  async autoKeyInfo() {
    return { exists: Boolean(this.key), created: this.key?.created, used: null, cursor: null, base: 'https://tg-photo-bot.example.workers.dev' };
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
}
