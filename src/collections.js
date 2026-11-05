// «Коллекции» как на iPhone. Всё считается прямо на устройстве из индекса за миллисекунды,
// поэтому коллекции пересобираются при каждом обновлении списка — никаких расписаний не нужно.
import { Grid, selection, el, photosCount, dayLabel, monthLabel } from './grid.js';
import { pushBack, confirmDestructive } from './tg.js';
import { exactGroups, similarGroups, pickKeeper } from './dupes.js';

const DAY = 86400000;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dayKey = (t) => {
  const d = new Date(t);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
};
const midnight = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const middle = (items) => items[Math.floor(items.length / 2)];

function km(la1, lo1, la2, lo2) {
  const r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function rangeLabel(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  const fmt = (d, withMonth) => (withMonth ? dayLabel(d).replace(/\s\d{4}$/, '') : String(d.getDate()));
  if (dayKey(a) === dayKey(b)) return dayLabel(da);
  if (da.getFullYear() !== db.getFullYear()) return `${dayLabel(da)} – ${dayLabel(db)}`;
  const sameMonth = da.getMonth() === db.getMonth();
  return `${fmt(da, !sameMonth)}–${fmt(db, true)} ${db.getFullYear()}`;
}

// ── Построение коллекций ───────────────────────────────────────────
function byDays(items) {
  const days = [];
  let cur = null;
  for (const it of items) {
    const k = dayKey(it.t);
    if (!cur || cur.k !== k) days.push((cur = { k, t: it.t, items: [] }));
    cur.items.push(it);
  }
  return days;
}

function recentDays(days) {
  const today = midnight(Date.now());
  return days
    .slice(-14)
    .reverse()
    .map((d) => {
      const diff = Math.round((today - midnight(d.t)) / DAY);
      const title = diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : dayLabel(new Date(d.t)).replace(` ${new Date().getFullYear()}`, '');
      return { title, sub: photosCount(d.items.length), items: d.items, cover: middle(d.items) };
    });
}

function onThisDay(days) {
  const now = new Date();
  const thisYear = now.getFullYear();
  for (const window of [0, 1, 3]) {
    const res = [];
    for (const d of days) {
      const dt = new Date(d.t);
      if (dt.getFullYear() >= thisYear) continue;
      const same = new Date(dt.getFullYear(), now.getMonth(), now.getDate());
      if (Math.abs(midnight(d.t) - same.getTime()) <= window * DAY) res.push(d);
    }
    if (res.length) {
      const byYear = new Map();
      for (const d of res) {
        const y = new Date(d.t).getFullYear();
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(...d.items);
      }
      return [...byYear]
        .sort((a, b) => b[0] - a[0])
        .map(([y, items]) => {
          const ago = thisYear - y;
          return {
            title: window ? `Около ${dayLabel(now).replace(/\s\d{4}$/, '')} ${y}` : `${dayLabel(now).replace(/\s\d{4}$/, '')} ${y}`,
            sub: `${ago} ${ago === 1 ? 'год' : ago < 5 ? 'года' : 'лет'} назад · ${photosCount(items.length)}`,
            items,
            cover: middle(items),
          };
        });
    }
  }
  return [];
}

// Дом — самая частая точка съёмки; поездка — подряд идущие дни со снимками дальше 100 км от дома.
function trips(items, days) {
  const geo = items.filter((it) => it.la != null);
  if (geo.length < 20) return [];
  const cells = new Map();
  for (const it of geo) {
    const k = `${Math.round(it.la * 2)}:${Math.round(it.lo * 2)}`;
    const c = cells.get(k) || { n: 0, la: 0, lo: 0 };
    c.n++;
    c.la += it.la;
    c.lo += it.lo;
    cells.set(k, c);
  }
  const home = [...cells.values()].sort((a, b) => b.n - a.n)[0];
  const hla = home.la / home.n;
  const hlo = home.lo / home.n;

  const out = [];
  let cur = null;
  for (const d of days) {
    const g = d.items.filter((it) => it.la != null);
    if (!g.length) continue;
    const la = g.reduce((s, it) => s + it.la, 0) / g.length;
    const lo = g.reduce((s, it) => s + it.lo, 0) / g.length;
    const dist = km(hla, hlo, la, lo);
    if (dist < 100) {
      cur = null;
      continue;
    }
    if (cur && midnight(d.t) - midnight(cur.end) <= 2 * DAY) {
      cur.days.push(d);
      cur.end = d.t;
      cur.dist = Math.max(cur.dist, dist);
    } else out.push((cur = { start: d.t, end: d.t, days: [d], dist }));
  }
  return out
    .map((tr) => {
      const its = tr.days.flatMap((d) => d.items);
      return {
        title: rangeLabel(tr.start, tr.end),
        sub: `${photosCount(its.length)} · ${Math.round(tr.dist / 10) * 10} км от дома`,
        items: its,
        cover: middle(its),
      };
    })
    .filter((c) => c.items.length >= 5)
    .reverse();
}

function folders(items) {
  const map = new Map();
  for (const it of items) {
    const f = it.p.replace(/^disk:\//, '').split('/').slice(0, -1).join('/') || '/';
    if (!map.has(f)) map.set(f, []);
    map.get(f).push(it);
  }
  return [...map]
    .sort((a, b) => b[1][b[1].length - 1].t - a[1][a[1].length - 1].t)
    .map(([f, its]) => ({ title: f.split('/').pop(), full: f, sub: its.length.toLocaleString('ru'), items: its, cover: its[its.length - 1] }));
}

const isScreenshot = (it) => /\.png$/i.test(it.n) || /screenshot|скриншот|снимок экрана/i.test(it.p);

// ── Экран ──────────────────────────────────────────────────────────
export class Collections {
  constructor(root, { loader, favorites, indexer, openPage, askName, onDeleteMany }) {
    this.loader = loader;
    this.onDeleteMany = onDeleteMany;
    this.indexer = indexer;
    this.askName = askName;
    this.favorites = favorites;
    this.openPage = openPage;
    this.items = [];
    this.root = el('div', 'collections scroller');
    root.append(this.root);
    this.jobs = new Map();
    this.io = new IntersectionObserver((e) => this.onIntersect(e), { rootMargin: '300px' });
    this.root.addEventListener('click', (e) => {
      const ml = e.target.closest('[data-ml]');
      if (ml) {
        this.indexer.enable();
        return;
      }
      const person = e.target.closest('[data-person]');
      if (person) return this.openPerson(this.people[Number(person.dataset.person)]);
      const c = e.target.closest('[data-c]');
      if (c) this.open(this.cols[Number(c.dataset.c)]);
    });
    // Анализ фото идёт фоном: статус обновляем часто, а сами коллекции — не чаще раза в пару секунд.
    indexer.addEventListener('progress', () => this.renderMlStatus());
    indexer.addEventListener('update', () => {
      if (this.updT) return;
      this.updT = setTimeout(() => {
        this.updT = 0;
        this.render(true);
      }, 2000);
    });
    favorites.onChange(() => {
      clearTimeout(this.favT);
      this.favT = setTimeout(() => this.render(true), 300);
    });
  }

  setItems(items) {
    this.items = items;
    this.render();
  }

  open(col) {
    if (col.dupes) return this.openDupes(col);
    this.openPage({ title: col.title, items: col.items });
  }

  // Точные копии: показываем все, а кнопкой удаляем лишние — в каждой группе остаётся одна.
  openDupes(col) {
    const extras = col.dupes.flatMap((g) => {
      const keep = pickKeeper(g);
      return g.filter((it) => it !== keep);
    });
    const page = this.openPage({
      title: col.title,
      items: col.items,
      action: this.onDeleteMany && {
        label: 'Удалить копии',
        onClick: async () => {
          const ok = await confirmDestructive({
            title: `Удалить ${photosCount(extras.length)}?`,
            message: 'Это лишние копии: от каждого фото останется одно — лучшего качества. Копии удалятся из галереи и из чата или канала.',
            ok: 'Удалить копии',
          });
          if (!ok) return;
          await this.onDeleteMany(extras);
          page.close();
        },
      },
    });
  }

  // Похожие снимки считаются по «отпечаткам» из анализа фото — заново, только когда что-то изменилось.
  similar(items) {
    const ix = this.indexer;
    if (!ix.enabled) return [];
    const key = `${items.length}|${items[items.length - 1]?.i}|${ix.recs.size}`;
    // Пока идёт анализ, отпечатки прибывают каждую секунду — пересчитываем не чаще раза в 30 секунд.
    if (this.simKey !== key && ix.state === 'running' && Date.now() - (this.simAt || 0) < 30000) return this.simGroups || [];
    if (this.simKey !== key) {
      this.simAt = Date.now();
      // Для 10 000 фото это полсекунды-секунда — считаем после отрисовки, потом обновляем коллекции.
      this.simKey = key;
      clearTimeout(this.simT);
      this.simT = setTimeout(() => {
        const groups = similarGroups(this.items, ix.recs);
        const changed = groups.length !== (this.simGroups || []).length || groups.flat().length !== (this.simGroups || []).flat().length;
        this.simGroups = groups;
        if (changed) this.render(true);
      }, 600);
    }
    return this.simGroups || [];
  }

  openPerson(person) {
    if (!person) return;
    const page = this.openPage({
      title: person.name || 'Без имени',
      items: person.items,
      action: {
        label: person.name ? 'Изменить' : 'Имя',
        onClick: async () => {
          const name = await this.askName(person.name);
          if (name == null) return;
          this.indexer.rename(person.ids, name);
          page.setTitle(name.trim() || 'Без имени');
        },
      },
    });
  }

  mlStatusText() {
    const ix = this.indexer;
    if (!ix.enabled) return '';
    const pct = (x) => Math.round(x * 100) + '%';
    switch (ix.state) {
      case 'loading':
        return ix.models.vision < 1 ? `Скачиваю модели распознавания… ${pct(ix.models.vision)}` : 'Готовлю распознавание…';
      case 'running':
        return `Анализирую фото: ${ix.done.toLocaleString('ru')} из ${ix.total.toLocaleString('ru')}`;
      case 'paused':
        return `Пауза: ${ix.done.toLocaleString('ru')} из ${ix.total.toLocaleString('ru')}. Продолжится, когда приложение открыто`;
      case 'error':
        return `Ошибка: ${ix.error}`;
      case 'done':
        return `Проанализировано ${ix.done.toLocaleString('ru')} фото`;
      default:
        return 'Подготовка…';
    }
  }

  renderMlStatus() {
    const st = this.root.querySelector('.ml-status');
    if (!st) {
      // Анализ только что включили, а на экране ещё карточка «Включить» — перерисуем один раз.
      if (this.indexer.enabled && this.items.length && !this.rendering) this.render(true);
      return;
    }
    st.textContent = this.mlStatusText();
    const bar = this.root.querySelector('.ml-bar > i');
    if (bar) {
      const ix = this.indexer;
      const v = ix.state === 'loading' ? ix.models.vision : ix.total ? ix.done / ix.total : 0;
      bar.style.width = Math.round(v * 100) + '%';
      bar.parentElement.hidden = ix.state === 'done';
    }
    const retry = this.root.querySelector('.ml-retry');
    if (retry) retry.hidden = this.indexer.state !== 'error';
  }

  peopleSection() {
    const ix = this.indexer;
    if (!ix.enabled) {
      return `<section class="c-section"><div class="ml-promo">
        <div class="ml-promo-title">✨ Люди и умный поиск</div>
        <p>Приложение само найдёт лица и научится искать по содержимому: «море», «кот», «торт», «закат».</p>
        <p>Всё анализируется прямо на вашем телефоне — фото никуда не отправляются.</p>
        <p class="muted">Нужно один раз скачать ≈ 100 МБ, лучше по Wi-Fi. Анализ идёт, пока приложение открыто.</p>
        <button class="big-btn" data-ml="enable">Включить</button>
      </div></section>`;
    }
    this.people = ix.people();
    const cards = this.people
      .map((p, i) => `<button class="person" data-person="${i}"><div class="face"${p.cover ? ' data-face' : ''}><img alt=""></div>
        <div class="person-name${p.name ? '' : ' muted'}">${esc(p.name || '+ Имя')}</div><div class="c-sub">${p.items.length.toLocaleString('ru')}</div></button>`)
      .join('');
    return `<section class="c-section">
      <div class="c-head"><h2>Люди</h2></div>
      <div class="ml-line"><span class="ml-status">${esc(this.mlStatusText())}</span><button class="text-btn ml-retry" data-ml="retry" hidden>Повторить</button></div>
      <div class="ml-bar"><i></i></div>
      ${cards ? `<div class="carousel people">${cards}</div>` : `<div class="empty-inline">${ix.state === 'done' ? 'Лиц пока не нашлось' : 'Люди появятся здесь по мере анализа'}</div>`}
    </section>`;
  }

  render(keepScroll) {
    this.rendering = true;
    try {
      this.renderInner(keepScroll);
    } finally {
      this.rendering = false;
    }
    this.renderMlStatus();
  }

  renderInner(keepScroll) {
    const scrollTop = this.root.scrollTop;
    const items = this.items;
    const days = byDays(items);
    const fav = items.filter((it) => this.favorites.has(it.p));
    const shots = items.filter(isScreenshot);
    this.cols = [];
    const add = (c) => this.cols.push(c) - 1;

    const section = (title, cls, list, hint) => {
      if (!list.length) return '';
      return `<section class="c-section">
        <div class="c-head"><h2>${title}</h2>${hint ? `<span class="muted">${hint}</span>` : ''}</div>
        <div class="carousel ${cls}">${list.map((c) => this.card(c, add(c), cls)).join('')}</div>
      </section>`;
    };

    const albums = [];
    albums.push({ title: 'Избранное', sub: fav.length.toLocaleString('ru'), items: fav, cover: fav[fav.length - 1], icon: 'heart' });
    albums.push(...folders(items));

    const types = [];
    if (shots.length) types.push({ title: 'Скриншоты', sub: shots.length.toLocaleString('ru'), items: shots, icon: 'shot' });
    const geoItems = items.filter((it) => it.la != null);
    if (geoItems.length) types.push({ title: 'С геометкой', sub: geoItems.length.toLocaleString('ru'), items: geoItems, icon: 'pin' });
    const exact = exactGroups(items);
    if (exact.length) {
      const extra = exact.reduce((n, g) => n + g.length - 1, 0);
      types.push({ title: 'Дубликаты', sub: `лишних ${extra.toLocaleString('ru')}`, items: exact.flat(), icon: 'dup', dupes: exact });
    }
    const sim = this.similar(items);
    if (sim.length) types.push({ title: 'Похожие', sub: `групп ${sim.length.toLocaleString('ru')}`, items: sim.flat(), icon: 'similar' });

    for (const j of this.jobs.values()) j.cancel();
    this.jobs.clear();
    this.io.disconnect();

    const tripList = trips(items, days);
    this.root.innerHTML = `
      <div class="large-title c-title">Коллекции</div>
      ${items.length ? '' : '<div class="empty-inline">Фото пока нет</div>'}
      ${section('Недавние дни', 'tall', recentDays(days))}
      ${this.peopleSection()}
      ${section('В этот день', 'wide', onThisDay(days))}
      ${section('Поездки', 'wide', tripList)}
      ${section('Альбомы', 'album', albums)}
      ${types.length ? `<section class="c-section"><div class="c-head"><h2>Типы медиа</h2></div><div class="group">${types
        .map((c) => `<button class="row" data-c="${add(c)}"><span class="row-icon">${ICON[c.icon]}</span><span class="row-title">${c.title}</span><span class="muted">${c.sub} ›</span></button>`)
        .join('')}</div></section>` : ''}
      <div class="c-foot">Коллекции собираются на устройстве и обновляются автоматически.</div>`;
    this.root.querySelectorAll('.c-card[data-cover], .person .face[data-face]').forEach((card) => this.io.observe(card));
    if (keepScroll === true) this.root.scrollTop = scrollTop;
  }

  card(c, i, cls) {
    const cover = c.cover ? ' data-cover' : '';
    if (cls === 'album') {
      return `<button class="c-card album-card" data-c="${i}"${cover}>
        <div class="c-img">${c.cover ? '<img alt="">' : `<span class="c-empty">${ICON[c.icon] || ''}</span>`}</div>
        <div class="c-name">${esc(c.title)}</div><div class="c-sub">${esc(c.sub)}</div></button>`;
    }
    return `<button class="c-card" data-c="${i}"${cover}>
      <img alt=""><div class="card-shade"></div>
      <div class="c-text"><div class="c-cap">${esc(c.title)}</div><div class="c-sub2">${esc(c.sub)}</div></div></button>`;
  }

  onIntersect(entries) {
    for (const e of entries) {
      const card = e.target;
      const img = card.querySelector('img');
      if (!img) continue;
      let cover;
      let size = card.closest('.wide') ? 'XL' : 'L';
      if (card.classList.contains('face')) {
        const person = this.people[Number(card.parentElement.dataset.person)];
        cover = person.cover.item;
        size = 'L';
        img.onload = () => placeFace(img, card, person.cover.b);
      } else cover = this.cols[Number(card.dataset.c)].cover;
      const col = { cover };
      if (e.isIntersecting) {
        if (img.getAttribute('src')) continue;
        const now = this.loader.peek(col.cover, size);
        if (now) {
          img.src = now;
          continue;
        }
        const any = this.loader.peekAny(col.cover, ['XL', 'L', 'M', 'S']);
        if (any) img.src = any;
        const job = this.loader.load(col.cover, size);
        this.jobs.set(card, job);
        job.promise.then((url) => (img.src = url), () => {}).finally(() => this.jobs.delete(card));
      } else {
        this.jobs.get(card)?.cancel();
        this.jobs.delete(card);
      }
    }
  }
}

const ICON = {
  heart: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 20.3s-7.8-4.6-7.8-10.4A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.8 2.7c0 5.8-7.8 10.4-7.8 10.4Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  shot: '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="2.5" width="12" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  dup: '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3.5" y="7.5" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 4.5h9a2.5 2.5 0 0 1 2.5 2.5v9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  similar: '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="2.5" y="6" width="9" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12.5" y="6" width="9" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m5 15 2.5-3 2 2.2M15 15l2.5-3 2 2.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/></svg>',
};

// Аватар человека: вырезаем лицо из миниатюры (рамка лица хранится в долях кадра).
function placeFace(img, box, b) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const S = box.clientWidth;
  if (!W || !S) return;
  const side = Math.max(b[2] * W, b[3] * H) * 1.6;
  const k = S / side;
  const cx = (b[0] + b[2] / 2) * W;
  const cy = (b[1] + b[3] / 2) * H;
  img.style.width = `${W * k}px`;
  img.style.height = `${H * k}px`;
  img.style.left = `${S / 2 - cx * k}px`;
  img.style.top = `${S / 2 - cy * k}px`;
}

// ── Страница коллекции (открывается поверх вкладки, как push в iOS) ──
export function openPage(parent, { title, items, loader, onOpen, action, onDeleteMany }) {
  // Без своей кнопки справа у страницы — «Выбрать»: отметить несколько фото и удалить.
  const canSelect = !action && onDeleteMany && items.length > 0;
  let list = items;
  const page = el('div', 'page');
  page.innerHTML = `
    <div class="page-grid scroller"></div>
    <header class="page-head">
      <button class="page-back" aria-label="Назад"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Назад</button>
      ${canSelect ? '<button class="page-selall" hidden>Выбрать все</button>' : ''}
      <div class="page-title"><div class="page-title-text">${esc(title)}</div><div class="muted page-count">${photosCount(items.length)}</div></div>
      ${action ? `<button class="page-action">${esc(action.label)}</button>` : ''}
      ${canSelect ? '<button class="page-action">Выбрать</button>' : ''}
    </header>
    ${items.length ? '' : '<div class="empty">Здесь пока пусто</div>'}`;
  parent.append(page);
  const grid = new Grid(page.querySelector('.page-grid'), { loader, onOpen: (i) => onOpen(list, i, grid) });
  requestAnimationFrame(() => {
    page.classList.add('open');
    grid.setItems(items, { reset: true });
  });
  let popBack = () => {};
  const close = () => {
    popBack();
    page.classList.remove('open');
    for (const t of grid.tiles.values()) t.job?.cancel();
    setTimeout(() => page.remove(), 350);
  };
  popBack = pushBack(close);
  page.querySelector('.page-back').addEventListener('click', close);
  swipeBack(page, close);
  if (action) page.querySelector('.page-action').addEventListener('click', action.onClick);
  if (canSelect) {
    const btn = page.querySelector('.page-action');
    const all = page.querySelector('.page-selall');
    const sel = selection(page, {
      grid,
      // Удалённые фото сразу убираем и с этой страницы.
      onDelete: async (chosen, progress) => {
        const gone = await onDeleteMany(chosen, progress);
        if (!gone?.size) return;
        list = list.filter((it) => !gone.has(it.p));
        grid.setItems(list);
        page.querySelector('.page-count').textContent = photosCount(list.length);
        if (!list.length) close();
      },
      onToggle: (on) => {
        page.classList.toggle('selecting', on);
        btn.textContent = on ? 'Готово' : 'Выбрать';
        all.hidden = !on;
      },
      onCount: (n) => (all.textContent = n && n === list.length ? 'Снять все' : 'Выбрать все'),
    });
    btn.addEventListener('click', () => (sel.active ? sel.exit() : sel.enter()));
    all.addEventListener('click', () => grid.selectAll(grid.sel.size !== list.length));
  }
  return {
    close,
    setTitle: (t) => (page.querySelector('.page-title-text').textContent = t),
  };
}

// Свайп вправо — назад, как на iPhone: страница едет за пальцем, отпустил — закрылась
// (или вернулась на место, если потянул совсем чуть-чуть). Работает с любого места экрана.
function swipeBack(page, close) {
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let dx = 0;
  let mode = ''; // '' — ещё не поняли жест, 'swipe' — тянем страницу, 'skip' — это прокрутка
  page.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return (mode = 'skip');
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      t0 = performance.now();
      dx = 0;
      mode = '';
    },
    { passive: true },
  );
  page.addEventListener(
    'touchmove',
    (e) => {
      if (mode === 'skip' || e.touches.length !== 1) return;
      const mx = e.touches[0].clientX - x0;
      const my = e.touches[0].clientY - y0;
      if (!mode) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        mode = mx > 0 && mx > Math.abs(my) * 1.4 ? 'swipe' : 'skip';
        if (mode !== 'swipe') return;
        page.classList.add('swiping');
      }
      e.preventDefault(); // пока тянем страницу, лента под пальцем не прокручивается
      dx = Math.max(0, mx);
      page.style.transform = `translateX(${dx}px)`;
    },
    { passive: false },
  );
  const end = () => {
    if (mode !== 'swipe') return;
    mode = 'skip';
    page.classList.remove('swiping');
    const v = dx / Math.max(1, performance.now() - t0); // px/мс
    page.style.transform = '';
    if (dx > page.clientWidth * 0.35 || (v > 0.35 && dx > 40)) close();
  };
  page.addEventListener('touchend', end);
  page.addEventListener('touchcancel', end);
}
