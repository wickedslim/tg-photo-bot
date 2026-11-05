// Дубликаты и похожие фото — всё считается на телефоне, как в разделе «Дубликаты» в «Фото» на iPhone.
//   • Дубликаты — один и тот же файл, загруженный дважды (то же имя, размер и время съёмки).
//     Их можно удалить одной кнопкой: остаётся одна копия.
//   • Похожие — почти одинаковые снимки: серия кадров, одно фото, присланное дважды в разном качестве.
//     Их сравнивает та же модель, что ищет по содержимому («море», «кот»), — по «отпечатку» картинки.
//     Удалять их сразу нельзя: вы смотрите и решаете сами.

const SIMILAR = 0.95; // насколько похожи «отпечатки» (1 — одно и то же изображение)
const WINDOW = 12; // соседи по времени съёмки, с которыми сравниваем каждое фото (серии кадров)
const TABLES = 6; // корзины для поиска похожих среди фото, снятых в разное время
const BITS = 10;

// Какую копию оставить: оригинал файлом лучше сжатого. Дальше — ту, что человек прислал боту сам
// (у такой нет поля o): старую бот не может ни удалить, ни заменить заглушкой, а копии, загруженные через
// галерею, автозагрузку или «Архив», он из чата уберёт. Иначе — самую раннюю.
function keepScore(it) {
  return (it.k === 'd' ? 4 : 0) + (!it.o ? 2 : 0) + (it.v ? 1 : 0);
}

export function pickKeeper(group) {
  return [...group].sort((a, b) => keepScore(b) - keepScore(a) || a.i - b.i)[0];
}

export function exactGroups(items) {
  const by = new Map();
  for (const it of items) {
    if (!it.s || !it.n || it.k !== 'd') continue; // имя и размер есть только у фото, присланных файлом
    const k = `${it.n}|${it.s}|${it.t}`;
    let g = by.get(k);
    if (!g) by.set(k, (g = []));
    g.push(it);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

// Сравниваем прямо 8-битные числа: так в несколько раз быстрее, чем в дробных.
function dotQ(a, b) {
  let s = 0;
  const qa = a.q;
  const qb = b.q;
  for (let i = 0; i < qa.length; i++) s += qa[i] * qb[i];
  return s * a.s * b.s;
}

// recs — отпечатки из анализа фото (indexer.recs). Возвращает группы похожих снимков, в каждой ≥ 2 фото.
export function similarGroups(items, recs) {
  const list = [];
  for (const it of items) {
    const c = recs.get(it.p)?.c;
    if (c) list.push({ it, c });
  }
  if (list.length < 2) return [];
  list.sort((a, b) => a.it.t - b.it.t);
  const n = list.length;
  const dim = list[0].c.q.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tried = new Set();
  const tryPair = (i, j) => {
    const key = i < j ? i * n + j : j * n + i;
    if (tried.has(key)) return;
    tried.add(key);
    if (dotQ(list[i].c, list[j].c) >= SIMILAR) parent[find(i)] = find(j);
  };
  // 1) соседи по времени — серии кадров;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < Math.min(n, i + 1 + WINDOW); j++) tryPair(i, j);
  // 2) похожие «отпечатки» из разного времени — одно фото, присланное дважды. Раскладываем по корзинам
  // по знакам разных чисел отпечатка: у почти одинаковых картинок знаки почти всегда совпадают.
  for (let t = 0; t < TABLES; t++) {
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const q = list[i].c.q;
      let h = 0;
      for (let b = 0; b < BITS; b++) if (q[((t * BITS + b) * 37) % dim] > 0) h |= 1 << b;
      let arr = buckets.get(h);
      if (!arr) buckets.set(h, (arr = []));
      arr.push(i);
    }
    for (const arr of buckets.values()) {
      if (arr.length > 60) continue; // слишком общая корзина — пропускаем, чтобы не тормозить
      for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) tryPair(arr[a], arr[b]);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(list[i].it);
  }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b[0].t - a[0].t);
}
