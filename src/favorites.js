// «Избранное» хранится в Telegram CloudStorage (синхронизируется между устройствами).
// В сам чат с ботом ничего не пишем: отметки хранятся в облаке Telegram (CloudStorage).
// Значение в CloudStorage ограничено 4096 символами — список путей режем на куски.
import { storage } from './tg.js';

const CHUNK = 3800;

export class Favorites {
  constructor(ns) {
    this.prefix = `fav_${ns}_`;
    this.set = new Set();
    this.listeners = new Set();
    this.saved = 0;
  }

  async load() {
    const n = parseInt(await storage.get(this.prefix + 'n'), 10) || 0;
    const parts = await Promise.all(Array.from({ length: n }, (_, i) => storage.get(this.prefix + i)));
    const all = [];
    for (const v of parts) {
      try {
        if (v) all.push(...JSON.parse(v));
      } catch {}
    }
    this.set = new Set(all);
    this.saved = n;
    this.emit();
  }

  has(path) {
    return this.set.has(path);
  }

  get size() {
    return this.set.size;
  }

  toggle(path) {
    if (this.set.has(path)) this.set.delete(path);
    else this.set.add(path);
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 600);
    return this.set.has(path);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  async clear() {
    this.set = new Set();
    this.emit();
    await this.save();
  }

  async save() {
    const chunks = [];
    let cur = [];
    let len = 2;
    for (const p of this.set) {
      const add = JSON.stringify(p).length + 1;
      if (len + add > CHUNK && cur.length) {
        chunks.push(cur);
        cur = [];
        len = 2;
      }
      cur.push(p);
      len += add;
    }
    if (cur.length) chunks.push(cur);
    await Promise.all(chunks.map((c, i) => storage.set(this.prefix + i, JSON.stringify(c))));
    for (let i = chunks.length; i < this.saved; i++) await storage.remove(this.prefix + i);
    await storage.set(this.prefix + 'n', String(chunks.length));
    this.saved = chunks.length;
  }
}
