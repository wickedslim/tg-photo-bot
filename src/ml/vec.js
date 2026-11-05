// «Отпечатки» фото (векторы CLIP) в компактном виде: 8-битные числа и общий масштаб.
// Отдельный модуль без браузерных зависимостей — его используют анализ фото и поиск похожих.

export function pack(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  const q = new Int8Array(v.length);
  const k = m ? 127 / m : 0;
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] * k);
  return { q, s: m / 127 };
}
export function unpack({ q, s }) {
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = q[i] * s;
  return v;
}
export function dotPacked({ q, s }, v) {
  let sum = 0;
  for (let i = 0; i < q.length; i++) sum += q[i] * v[i];
  return sum * s;
}
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
export function normalized(v) {
  const s = Math.sqrt(dot(v, v)) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}
