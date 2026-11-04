// Медиатека в духе «Фото» на iPhone: «Годы / Месяцы / Все фото», свежие снимки внизу,
// сетка с виртуальным скроллом и сменой числа колонок щипком.
import { haptic } from './tg.js';
import { Grid, el, monthLabel, photosCount, dayLabel } from './grid.js';

// ── Карточки «Месяцы» и «Годы» ─────────────────────────────────────
function groupMonths(items) {
  const groups = [];
  let cur = null;
  items.forEach((it, i) => {
    const d = new Date(it.t);
    const y = d.getFullYear();
    const m = d.getMonth();
    if (!cur || cur.y !== y || cur.m !== m) {
      cur = { y, m, start: i, end: i };
      groups.push(cur);
    } else cur.end = i;
  });
  return groups;
}

function groupYears(months) {
  const years = [];
  for (const g of months) {
    let y = years[years.length - 1];
    if (!y || y.y !== g.y) years.push((y = { y: g.y, start: g.start, end: g.end, months: [] }));
    y.end = g.end;
    y.months.push(g);
  }
  return years;
}

class Cards {
  constructor(scroller, { loader, kind, onPick }) {
    this.el = scroller;
    this.loader = loader;
    this.kind = kind;
    this.onPick = onPick;
    this.list = el('div', 'cards ' + kind);
    this.el.append(this.list);
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.el,
      rootMargin: '600px 0px',
    });
    this.jobs = new Map();
    this.list.addEventListener('click', (e) => {
      const c = e.target.closest('.card');
      if (c) this.onPick(this.groups[Number(c.dataset.g)]);
    });
  }

  setGroups(groups, items) {
    this.items = items;
    this.groups = groups;
    const atBottom = !this.list.childElementCount || this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    for (const j of this.jobs.values()) j.cancel();
    this.jobs.clear();
    this.io.disconnect();
    this.list.textContent = '';
    groups.forEach((g, gi) => {
      const card = el('div', 'card');
      card.dataset.g = gi;
      const count = g.end - g.start + 1;
      const title =
        this.kind === 'years'
          ? `<div class="card-title year">${g.y}</div>`
          : `<div class="card-title">${monthLabel(g.y, g.m)}</div><div class="card-sub">${g.y} · ${photosCount(count)}</div>`;
      card.innerHTML = `<img alt="" draggable="false"><div class="card-shade"></div><div class="card-text">${title}</div>`;
      if (this.kind === 'years') card.querySelector('.card-text').insertAdjacentHTML('beforeend', `<div class="card-sub">${photosCount(count)}</div>`);
      card._item = this.cover(g);
      this.list.append(card);
      this.io.observe(card);
    });
    if (atBottom) this.scrollToBottom();
  }

  cover(g) {
    // Для года берём самый «насыщенный» месяц, внутри — фото из середины.
    const src = this.kind === 'years' ? g.months.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a)) : g;
    return this.items[Math.floor((src.start + src.end) / 2)];
  }

  onIntersect(entries) {
    for (const e of entries) {
      const card = e.target;
      const img = card.querySelector('img');
      if (e.isIntersecting) {
        if (img.src) continue;
        const item = card._item;
        const now = this.loader.peek(item, 'medium');
        if (now) {
          img.src = now;
          continue;
        }
        const any = this.loader.peekAny(item, ['large', 'thumb']);
        if (any) img.src = any;
        const job = this.loader.load(item, 'medium');
        this.jobs.set(card, job);
        job.promise.then((url) => (img.src = url), () => {}).finally(() => this.jobs.delete(card));
      } else {
        this.jobs.get(card)?.cancel();
        this.jobs.delete(card);
      }
    }
  }

  scrollToBottom() {
    requestAnimationFrame(() => (this.el.scrollTop = this.el.scrollHeight));
  }

  scrollToGroup(pred) {
    const gi = this.groups.findIndex(pred);
    const card = this.list.children[gi];
    if (card) this.el.scrollTop = card.offsetTop - this.el.clientHeight / 2 + card.offsetHeight / 2;
  }
}

// ── Экран медиатеки целиком ────────────────────────────────────────
export class Library {
  constructor(root, { loader, onOpen, onSettings, onUpload }) {
    this.root = el('div', 'library');
    this.root.innerHTML = `
      <div class="view view-years scroller"></div>
      <div class="view view-months scroller"></div>
      <div class="view view-all scroller"></div>
      <div class="top-shade"></div>
      <header class="topbar">
        <div class="topbar-text"><div class="topbar-title"></div><div class="topbar-sub"></div></div>
        <div class="topbar-actions">
          <span class="spinner small" hidden></span>
          <button class="pill" data-act="upload">Загрузить</button>
          <button class="pill icon" data-act="settings" aria-label="Настройки">
            <svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
          </button>
        </div>
      </header>
      <div class="bottom-shade"></div>
      <nav class="segmented" role="tablist">
        <span class="seg-thumb"></span>
        <button data-view="years">Годы</button>
        <button data-view="months">Месяцы</button>
        <button data-view="all">Все фото</button>
      </nav>
      <div class="upload-bar" hidden><div class="upload-text"></div><div class="upload-track"><i></i></div></div>
      <div class="empty" hidden></div>`;
    root.append(this.root);

    const q = (s) => this.root.querySelector(s);
    this.title = q('.topbar-title');
    this.sub = q('.topbar-sub');
    this.spinner = q('.topbar .spinner');
    this.emptyEl = q('.empty');
    this.views = { years: q('.view-years'), months: q('.view-months'), all: q('.view-all') };
    this.items = [];

    this.grid = new Grid(this.views.all, {
      loader,
      scrubBottom: 56, // над переключателем «Годы / Месяцы / Все фото»
      onOpen: (i) => onOpen(this.items, i, this.grid),
      onScrollInfo: (item, cols) => {
        if (this.view !== 'all' || !item) return;
        const d = new Date(item.t);
        this.title.textContent = cols <= 3 ? dayLabel(d) : `${monthLabel(d.getFullYear(), d.getMonth())} ${d.getFullYear()}`;
        this.sub.textContent = '';
      },
    });
    this.months = new Cards(this.views.months, {
      loader,
      kind: 'months',
      onPick: (g) => {
        this.show('all');
        this.grid.scrollToIndex(g.start);
      },
    });
    this.years = new Cards(this.views.years, {
      loader,
      kind: 'years',
      onPick: (g) => {
        this.show('months');
        this.months.scrollToGroup((m) => m.y === g.y && m.end === g.end);
      },
    });

    q('.segmented').addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.view;
      if (v) this.show(v);
    });
    q('[data-act="settings"]').addEventListener('click', onSettings);
    q('[data-act="upload"]').addEventListener('click', onUpload);
    this.uploadBar = q('.upload-bar');
    // Ширина кнопок может поменяться после первой отрисовки (шрифты, поворот экрана) — двигаем «бегунок» следом.
    new ResizeObserver(() => this.placeThumb()).observe(q('.segmented'));
    this.show('all');
  }

  show(view) {
    if (this.view === view) return;
    this.view = view;
    for (const [k, v] of Object.entries(this.views)) v.classList.toggle('active', k === view);
    const btns = [...this.root.querySelectorAll('.segmented button')];
    btns.forEach((b) => b.classList.toggle('selected', b.dataset.view === view));
    requestAnimationFrame(() => this.placeThumb());
    if (view === 'all') this.grid.render();
    else {
      this.title.textContent = view === 'years' ? 'Годы' : 'Месяцы';
      this.sub.textContent = this.items.length ? photosCount(this.items.length) : '';
    }
    haptic('light');
  }

  placeThumb() {
    const sel = this.root.querySelector('.segmented .selected');
    const thumb = this.root.querySelector('.seg-thumb');
    if (!sel || !sel.offsetWidth) return;
    thumb.style.width = sel.offsetWidth + 'px';
    thumb.style.transform = `translateX(${sel.offsetLeft}px)`;
  }

  setItems(items) {
    this.items = items;
    this.emptyEl.hidden = items.length > 0;
    if (!items.length) {
      this.emptyEl.innerHTML = '<div class="empty-title">Здесь пока пусто</div><div>Нажмите «Загрузить» или пришлите фото боту в чат — они появятся здесь.</div>';
      this.title.textContent = 'Медиатека';
    }
    this.grid.setItems(items);
    const months = groupMonths(items);
    this.months.setGroups(months, items);
    this.years.setGroups(groupYears(months), items);
    if (this.view !== 'all') this.sub.textContent = items.length ? photosCount(items.length) : '';
  }

  // Полоска загрузки над переключателем «Годы / Месяцы / Все фото».
  setUpload(state) {
    this.uploadBar.hidden = !state;
    if (!state) return;
    this.uploadBar.querySelector('.upload-text').textContent = state.text;
    this.uploadBar.querySelector('i').style.width = `${Math.round((state.progress || 0) * 100)}%`;
  }

  setBusy(busy, text) {
    this.spinner.hidden = !busy;
    if (busy && text && !this.items.length) {
      this.emptyEl.hidden = false;
      this.emptyEl.innerHTML = `<span class="spinner"></span><div>${text}</div>`;
    }
  }

  // Для просмотрщика: синхронизировать сетку с текущим фото и дать миниатюру для анимации.
  revealIndex(i) {
    if (this.view === 'all') this.grid.ensureVisible(i);
  }

  thumbFor(i) {
    return this.view === 'all' ? this.grid.tileImg(i) : null;
  }
}
