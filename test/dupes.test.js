// Дубликаты и похожие фото: поиск на телефоне по именам файлов и «отпечаткам» картинок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactGroups, similarGroups, pickKeeper } from '../src/dupes.js';

// «Отпечаток» в том виде, как его хранит анализ фото: 8-битные числа и масштаб.
function packed(v) {
  const n = Math.hypot(...v);
  const u = v.map((x) => x / n);
  const m = Math.max(...u.map(Math.abs));
  return { q: Int8Array.from(u, (x) => Math.round((x * 127) / m)), s: m / 127 };
}
function rnd(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
}
const vec = (seed) => Array.from({ length: 512 }, rnd(seed));
const near = (v, seed, k = 0.12) => v.map((x, i) => x + k * vec(seed)[i]);

test('дубликаты: тот же файл дважды — одна группа, оставляем копию получше', () => {
  const a = { i: 1, p: 'a', k: 'd', n: 'IMG_1.HEIC', s: 100, t: 5 };
  const b = { i: 2, p: 'b', k: 'd', n: 'IMG_1.HEIC', s: 100, t: 5, o: 'channel' };
  const c = { i: 3, p: 'c', k: 'd', n: 'IMG_1.HEIC', s: 999, t: 5 }; // другой файл с тем же именем
  const d = { i: 4, p: 'd', k: 'p', s: 100, t: 5 }; // сжатое — без имени, точно не сравнить
  const groups = exactGroups([a, b, c, d]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((x) => x.i), [1, 2]);
  assert.equal(pickKeeper(groups[0]).i, 1); // копия, присланная боту вручную: её бот из чата не уберёт
  assert.equal(pickKeeper([{ i: 7, k: 'd', o: 'auto' }, { i: 8, k: 'd' }]).i, 8);
  assert.equal(pickKeeper([{ i: 5, k: 'p' }, { i: 6, k: 'd' }]).i, 6); // оригинал лучше сжатого
});

test('похожие: серия кадров и одно фото, присланное дважды в разное время', () => {
  const base1 = vec(1);
  const base2 = vec(2);
  const items = [];
  const recs = new Map();
  const add = (i, t, v) => {
    const it = { i, p: 'p' + i, t };
    items.push(it);
    recs.set(it.p, { c: packed(v) });
  };
  for (let i = 0; i < 40; i++) add(100 + i, i * 1000, vec(1000 + i)); // разные фото
  add(1, 50_000, base1); // серия из двух кадров подряд
  add(2, 51_000, near(base1, 7, 0.05));
  add(3, 1_000_000, base2); // то же фото через неделю
  add(4, 900_000_000, near(base2, 9, 0.03));
  const groups = similarGroups(items, recs);
  const ids = groups.map((g) => g.map((x) => x.i).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(ids, [[1, 2], [3, 4]]);
});
