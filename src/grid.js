// Общие помощники и виртуальная сетка фото (лента, поиск, коллекции).
import { haptic, pushBack, confirmDestructive } from './tg.js';
import { isAbort } from './api.js';

const COLS = [1, 3, 5, 9];
const SIZE_FOR_COLS = { 1: 'XL', 3: 'L', 5: 'M', 9: 'S' };
const ALL_SIZES = ['XL', 'L', 'M', 'S'];
const GAP = 2;

const fmtDay = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtMonthName = new Intl.DateTimeFormat('ru', { month: 'long' });
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const stripYear = (s) => s.replace(/\s?г\.$/, '');
export const dayLabel = (t) => stripYear(fmtDay.format(t));
export const monthLabel = (y, m) => cap(fmtMonthName.format(new Date(y, m, 1)));
export const photosCount = (n) => `${n.toLocaleString('ru')} фото`;

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// ── Сетка «Все фото» ────────────────────────────────────────────────
export class Grid {
  constructor(scroller, { loader, onOpen, onScrollInfo, scrubBottom = 0 }) {
    this.el = scroller;
    this.loader = loader;
    this.onOpen = onOpen;
    this.onScrollInfo = onScrollInfo;
    this.items = [];
    this.cols = 3;
    this.tiles = new Map(); // index -> { el, img, job }
    this.inner = el('div', 'grid-inner');
    this.footer = el('div', 'grid-footer');
    this.el.append(this.inner, this.footer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    const relayout = () => {
      if (!this.items.length) return;
      const anchor = this.anchor();
      this.layout();
      this.restore(anchor);
    };
    new ResizeObserver(relayout).observe(this.el);
    // Отступ сверху зависит от выреза экрана и кнопок Telegram — когда они меняются, пересчитываем сетку.
    window.addEventListener('insetschange', () => {
      if (this.padTop() !== this.top) relayout();
    });
    this.inner.addEventListener('click', (e) => {
      const t = e.target.closest('.tile');
      if (!t) return;
      if (this.selecting) {
        if (!this.dragged) this.toggle(Number(t.dataset.i));
      } else this.onOpen(Number(t.dataset.i));
    });
    this.selecting = false;
    this.sel = new Set(); // выбранные фото — по пути файла, чтобы выбор не сбился при обновлении ленты
    this.setupPinch();
    this.setupDragSelect();
    this.scrubBottom = scrubBottom;
    this.setupScrubber();
  }

  get size() {
    return SIZE_FOR_COLS[this.cols];
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  padTop() {
    // --pad-top задан через calc(), поэтому берём уже вычисленный padding.
    return parseFloat(getComputedStyle(this.inner).paddingTop) || 0;
  }

  layout() {
    const w = this.el.clientWidth;
    this.cell = (w - GAP * (this.cols - 1)) / this.cols;
    this.rowH = this.cell + GAP;
    this.top = this.padTop();
    const rows = Math.ceil(this.items.length / this.cols);
    this.inner.style.height = `${this.top + Math.max(0, rows * this.rowH - GAP)}px`;
    this.inner.classList.toggle('small', this.cols >= 9);
    this.footer.textContent = this.items.length ? photosCount(this.items.length) : '';
    for (const [i, t] of this.tiles) this.unmount(i, t);
    this.render();
  }

  // reset: новый набор (поиск, другая коллекция) — сразу к самым свежим фото внизу.
  setItems(items, { reset = false } = {}) {
    const atBottom = this.isAtBottom();
    const anchor = this.items.length && !reset ? this.anchor() : null;
    this.items = items;
    if (this.sel.size) {
      const have = new Set(items.map((it) => it.p));
      for (const p of this.sel) if (!have.has(p)) this.sel.delete(p);
      this.onSelect?.(this.sel.size);
    }
    for (const [i, t] of this.tiles) this.unmount(i, t);
    this.layout();
    if (!anchor || atBottom) this.scrollToBottom();
    else this.restore(anchor);
  }

  isAtBottom() {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
  }

  scrollToBottom() {
    this.el.scrollTop = this.el.scrollHeight;
    this.render();
  }

  // Какое фото сейчас по центру экрана — чтобы не потерять его при смене колонок.
  anchor(clientY) {
    const rect = this.el.getBoundingClientRect();
    const y = clientY != null ? clientY - rect.top : this.el.clientHeight / 2;
    const row = Math.max(0, Math.floor((this.el.scrollTop + y - this.top) / this.rowH));
    const path = this.items[Math.min(this.items.length - 1, row * this.cols)]?.p;
    return { path, index: Math.min(this.items.length - 1, row * this.cols), y };
  }

  restore({ path, index, y }) {
    let i = index;
    if (path && this.items[i]?.p !== path) {
      const found = this.items.findIndex((it) => it.p === path);
      if (found >= 0) i = found;
    }
    const row = Math.floor(Math.max(0, i) / this.cols);
    this.el.scrollTop = this.top + row * this.rowH - y + this.rowH / 2;
    this.render();
  }

  scrollToIndex(i, where = 'top') {
    const row = Math.floor(i / this.cols);
    const y = this.top + row * this.rowH;
    if (where === 'top') this.el.scrollTop = y - this.top;
    else this.el.scrollTop = y - (this.el.clientHeight - this.cell) / 2;
    this.render();
  }

  ensureVisible(i) {
    const row = Math.floor(i / this.cols);
    const y = this.top + row * this.rowH;
    const st = this.el.scrollTop;
    const bottomPad = 110;
    if (y < st + this.top || y + this.cell > st + this.el.clientHeight - bottomPad) this.scrollToIndex(i, 'center');
  }

  // Интерфейс для просмотрщика.
  revealIndex(i) {
    if (this.el.offsetParent !== null) this.ensureVisible(i);
  }

  thumbFor(i) {
    return this.tileImg(i);
  }

  tileImg(i) {
    return this.tiles.get(i)?.img || null;
  }

  render() {
    if (!this.items.length || !this.rowH) return;
    const st = this.el.scrollTop;
    const h = this.el.clientHeight;
    const overscan = 2;
    const firstRow = Math.max(0, Math.floor((st - this.top) / this.rowH) - overscan);
    const lastRow = Math.floor((st + h - this.top) / this.rowH) + overscan;
    const from = firstRow * this.cols;
    const to = Math.min(this.items.length - 1, (lastRow + 1) * this.cols - 1);

    for (const [i, t] of this.tiles) if (i < from || i > to) this.unmount(i, t);
    for (let i = from; i <= to; i++) if (!this.tiles.has(i)) this.mount(i);

    const visibleRow = Math.max(0, Math.floor((st + this.top * 0.5) / this.rowH));
    const first = this.items[Math.min(this.items.length - 1, visibleRow * this.cols)];
    this.onScrollInfo?.(first, this.cols);
  }

  mount(i) {
    const item = this.items[i];
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    const tile = el('div', 'tile');
    tile.dataset.i = i;
    if (this.sel.has(item.p)) tile.classList.add('sel');
    tile.style.cssText = `width:${this.cell}px;height:${this.cell}px;transform:translate(${col * (this.cell + GAP)}px,${this.top + row * this.rowH}px)`;
    const img = el('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.onload = () => {
      tile.classList.add('loaded');
      this.loader.noteDims(item, img);
    };
    tile.append(img);
    const t = { el: tile, img, job: null };
    const exact = this.loader.peek(item, this.size);
    if (exact) img.src = exact;
    else {
      const any = this.loader.peekAny(item, ALL_SIZES);
      if (any) img.src = any;
      t.job = this.loader.load(item, this.size);
      t.job.promise.then(
        (url) => {
          if (this.tiles.get(i) === t) img.src = url;
        },
        (e) => {
          if (!isAbort(e)) tile.classList.add('failed');
        },
      );
    }
    this.inner.append(tile);
    this.tiles.set(i, t);
  }

  unmount(i, t) {
    t.job?.cancel();
    t.el.remove();
    this.tiles.delete(i);
  }

  // ── Выбор нескольких фото ──
  setSelecting(on) {
    this.selecting = on;
    this.sel.clear();
    this.inner.classList.toggle('selecting', on);
    // Вбок палец выбирает фото, вверх-вниз — прокручивает ленту.
    this.el.style.touchAction = on ? 'pan-y' : '';
    for (const t of this.tiles.values()) t.el.classList.remove('sel');
    this.onSelect?.(0);
  }

  markTiles() {
    for (const [i, t] of this.tiles) t.el.classList.toggle('sel', this.sel.has(this.items[i]?.p));
  }

  toggle(i) {
    const p = this.items[i]?.p;
    if (!p) return;
    if (this.sel.has(p)) this.sel.delete(p);
    else this.sel.add(p);
    this.markTiles();
    haptic('select');
    this.onSelect?.(this.sel.size);
  }

  selectAll(on) {
    this.sel = new Set(on ? this.items.map((it) => it.p) : []);
    this.markTiles();
    this.onSelect?.(this.sel.size);
  }

  selectedItems() {
    return this.items.filter((it) => this.sel.has(it.p));
  }

  // Провести пальцем вбок по фото — отмечаются все фото между первым и тем, что под пальцем, как на iPhone.
  // У края экрана лента сама прокручивается дальше.
  setupDragSelect() {
    const s = { mode: '', x0: 0, y0: 0, x: 0, y: 0, from: -1, to: -1, on: true, base: null, raf: 0 };
    const indexAt = (x, y) => {
      const r = this.el.getBoundingClientRect();
      const col = Math.min(this.cols - 1, Math.max(0, Math.floor((x - r.left) / (this.cell + GAP))));
      const row = Math.max(0, Math.floor((y - r.top + this.el.scrollTop - this.top) / this.rowH));
      return Math.min(this.items.length - 1, row * this.cols + col);
    };
    const extend = (to) => {
      if (to === s.to || to < 0) return;
      s.to = to;
      const lo = Math.min(s.from, to);
      const hi = Math.max(s.from, to);
      this.sel = new Set(s.base);
      for (let i = lo; i <= hi; i++) {
        if (s.on) this.sel.add(this.items[i].p);
        else this.sel.delete(this.items[i].p);
      }
      this.markTiles();
      haptic('select');
      this.onSelect?.(this.sel.size);
    };
    const autoscroll = () => {
      s.raf = 0;
      if (s.mode !== 'drag') return;
      const r = this.el.getBoundingClientRect();
      const top = r.top + this.top + 40;
      const bottom = r.bottom - 150;
      const v = s.y < top ? -Math.min(24, (top - s.y) / 3 + 2) : s.y > bottom ? Math.min(24, (s.y - bottom) / 3 + 2) : 0;
      if (!v) return;
      this.el.scrollTop += v;
      extend(indexAt(s.x, s.y));
      s.raf = requestAnimationFrame(autoscroll);
    };
    this.el.addEventListener(
      'touchstart',
      (e) => {
        if (!this.selecting || e.touches.length !== 1 || !this.items.length) return void (s.mode = 'skip');
        s.x0 = s.x = e.touches[0].clientX;
        s.y0 = s.y = e.touches[0].clientY;
        s.mode = '';
        this.dragged = false;
      },
      { passive: true },
    );
    this.el.addEventListener(
      'touchmove',
      (e) => {
        if (!this.selecting) return;
        e.stopPropagation(); // пока выбираем, свайп «назад» у страницы альбома не срабатывает
        if (s.mode === 'skip' || e.touches.length !== 1) return;
        s.x = e.touches[0].clientX;
        s.y = e.touches[0].clientY;
        if (!s.mode) {
          const dx = Math.abs(s.x - s.x0);
          const dy = Math.abs(s.y - s.y0);
          if (dx < 10 && dy < 10) return;
          if (dy >= dx) return void (s.mode = 'skip');
          s.mode = 'drag';
          this.dragged = true;
          s.from = indexAt(s.x0, s.y0);
          s.to = -1;
          s.on = !this.sel.has(this.items[s.from].p);
          s.base = new Set(this.sel);
        }
        e.preventDefault();
        extend(indexAt(s.x, s.y));
        if (!s.raf) s.raf = requestAnimationFrame(autoscroll);
      },
      { passive: false },
    );
    const end = () => {
      s.mode = 'skip';
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
    this.el.addEventListener('touchend', end);
    this.el.addEventListener('touchcancel', end);
  }

  // ── Ползунок прокрутки, как в «Фото» на iPhone ──
  // Тонкая полупрозрачная капсула у правого края: появляется при прокрутке, её можно схватить
  // и быстро протащить через всю ленту. Дата меняется в заголовке. Через секунду без движения прячется.
  setupScrubber() {
    const host = this.el.parentElement;
    const bar = el('div', 'scrubber', '<i></i>');
    host.append(bar);
    const BAR_H = 64;
    const st = { dragging: false, visible: false, hideT: 0, row: -1, travel: 0, lastY: 0, lastT: 0 };
    this.scrub = st;

    const track = () => {
      const tabbar = document.querySelector('.tabbar');
      const top = this.top + 4;
      const bottom = this.el.clientHeight - (tabbar ? tabbar.offsetHeight : 0) - this.scrubBottom - 6;
      return { top, h: Math.max(1, bottom - top - BAR_H) };
    };
    const maxScroll = () => Math.max(1, this.el.scrollHeight - this.el.clientHeight);
    const place = () => {
      const t = track();
      bar.style.transform = `translateY(${t.top + (this.el.scrollTop / maxScroll()) * t.h}px)`;
    };
    const hide = () => {
      if (st.dragging) return;
      st.visible = false;
      bar.classList.remove('show');
    };
    const show = () => {
      clearTimeout(st.hideT);
      if (!st.visible) {
        st.visible = true;
        bar.classList.add('show');
      }
      if (!st.dragging) st.hideT = setTimeout(hide, 1200);
    };

    this.el.addEventListener(
      'scroll',
      () => {
        if (this.el.scrollHeight < this.el.clientHeight * 2.5 || !this.el.offsetParent) return;
        // Появляемся не сразу, а когда за одну прокрутку пролистали больше одного экрана.
        const now = performance.now();
        const y = this.el.scrollTop;
        const delta = Math.abs(y - st.lastY);
        st.lastY = y;
        if (now - st.lastT > 500) st.travel = 0; // пауза — начался новый жест
        st.lastT = now;
        // Скачок сразу на много экранов — это программный переход (открыли ленту, выбрали месяц), а не палец.
        if (delta > this.el.clientHeight * 3 && !st.dragging) {
          st.travel = 0;
          return;
        }
        st.travel += delta;
        if (!st.visible && !st.dragging && st.travel < this.el.clientHeight) return;
        place();
        show();
        // Лёгкий щелчок вибрацией на каждой новой строке, пока тащим ползунок.
        if (st.dragging) {
          const row = Math.floor(this.el.scrollTop / (this.rowH * 6));
          if (row !== st.row) {
            if (st.row !== -1) haptic('select');
            st.row = row;
          }
        }
      },
      { passive: true },
    );

    let grab = 0;
    bar.addEventListener('pointerdown', (e) => {
      if (!st.visible) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const t = track();
      grab = e.clientY - this.el.getBoundingClientRect().top - (t.top + (this.el.scrollTop / maxScroll()) * t.h);
      st.dragging = true;
      st.row = -1;
      clearTimeout(st.hideT);
      bar.classList.add('drag');
      haptic('light');
    });
    bar.addEventListener('pointermove', (e) => {
      if (!st.dragging) return;
      const t = track();
      const y = e.clientY - this.el.getBoundingClientRect().top - grab;
      this.el.scrollTop = Math.min(1, Math.max(0, (y - t.top) / t.h)) * maxScroll();
    });
    const end = () => {
      if (!st.dragging) return;
      st.dragging = false;
      bar.classList.remove('drag');
      show();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  setCols(cols, clientY) {
    if (cols === this.cols) return;
    const anchor = this.anchor(clientY);
    this.cols = cols;
    haptic('light');
    this.inner.classList.remove('zooming');
    void this.inner.offsetWidth;
    this.inner.classList.add('zooming');
    this.layout();
    this.restore(anchor);
  }

  zoom(dir, clientY) {
    const i = COLS.indexOf(this.cols);
    const next = COLS[Math.max(0, Math.min(COLS.length - 1, i + dir))];
    this.setCols(next, clientY);
  }

  setupPinch() {
    let start = 0;
    let cy = 0;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          start = dist(e.touches);
          cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        }
      },
      { passive: true },
    );
    this.el.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 2 || !start) return;
        e.preventDefault();
        const r = dist(e.touches) / start;
        if (r > 1.35) {
          this.zoom(-1, cy);
          start = dist(e.touches);
        } else if (r < 0.7) {
          this.zoom(1, cy);
          start = dist(e.touches);
        }
      },
      { passive: false },
    );
    this.el.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) start = 0;
    });
    // Ctrl + колесо / щипок на тачпаде — для Telegram Desktop.
    let acc = 0;
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        acc += e.deltaY;
        if (Math.abs(acc) > 40) {
          this.zoom(acc > 0 ? 1 : -1, e.clientY);
          acc = 0;
        }
      },
      { passive: false },
    );
  }
}

// ── Режим «Выбрать» ─────────────────────────────────────────────────
// Касание отмечает фото, ведение пальцем вбок — сразу несколько. Внизу — сколько выбрано и корзина.
// Кнопка «Назад» в Telegram выходит из выбора.
const TRASH = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 6.5h16M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7M6.3 6.5l.9 12.6c.1 1 .9 1.9 2 1.9h5.6c1.1 0 1.9-.9 2-1.9l.9-12.6M10 10.5v6.5M14 10.5v6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function selection(host, { grid, onDelete, onToggle, onCount }) {
  const bar = el('div', 'select-bar', `<span class="select-count"></span><button class="select-del" aria-label="Удалить" disabled>${TRASH}</button>`);
  bar.hidden = true;
  host.append(bar);
  const count = bar.querySelector('.select-count');
  const del = bar.querySelector('.select-del');
  let popBack = null;
  let busy = false;
  grid.onSelect = (n) => {
    onCount?.(n);
    if (busy) return;
    count.textContent = n ? `Выбрано: ${photosCount(n)}` : 'Выберите фото';
    del.disabled = !n;
  };
  const api = {
    active: false,
    enter() {
      if (api.active) return;
      api.active = true;
      grid.setSelecting(true);
      bar.hidden = false;
      popBack = pushBack(api.exit);
      onToggle?.(true);
      haptic('light');
    },
    exit() {
      if (!api.active || busy) return;
      api.active = false;
      grid.setSelecting(false);
      bar.hidden = true;
      popBack?.();
      popBack = null;
      onToggle?.(false);
    },
  };
  del.addEventListener('click', async () => {
    const list = grid.selectedItems();
    if (!list.length || busy) return;
    const ok = await confirmDestructive({
      title: list.length === 1 ? 'Удалить фото?' : `Удалить ${photosCount(list.length)}?`,
      message: 'Фото удалятся из галереи и из чата с ботом. Вернуть их будет нельзя.',
      ok: 'Удалить',
    });
    if (!ok) return;
    busy = true;
    del.disabled = true;
    count.textContent = `Удаляю… 0 из ${list.length}`;
    try {
      await onDelete(list, (n) => (count.textContent = `Удаляю… ${n} из ${list.length}`));
    } finally {
      busy = false;
      api.exit();
    }
  });
  return api;
}
