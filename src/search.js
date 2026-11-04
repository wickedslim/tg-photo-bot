// Поиск по дате, имени файла, подписи и альбому. Работает мгновенно по локальному индексу, без запросов к серверу.
import { Grid, el, photosCount, monthLabel } from './grid.js';

const MONTHS = [/^янв/, /^фев/, /^мар/, /^апр/, /^ма[йяе]/, /^июн/, /^июл/, /^авг/, /^сен/, /^окт/, /^ноя/, /^дек/];
const SEASONS = { зим: [11, 0, 1], весн: [2, 3, 4], лет: [5, 6, 7], осен: [8, 9, 10] };

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
const textCache = new WeakMap();
const textOf = (it) => {
  let t = textCache.get(it);
  if (t == null) textCache.set(it, (t = norm(it.p.replace(/^disk:\//, '') + (it.c ? ' ' + it.c : ''))));
  return t;
};

// Разбираем запрос: условия по дате (tests) и обычные слова (words).
export function parseQuery(q) {
  const tests = [];
  const words = [];
  const tokens = norm(q).split(/[\s,]+/).filter(Boolean);
  for (const tok of tokens) {
    // 12.05.2024, 12.05, 2024-05-12, 2024-05
    const parts = tok.split(/[./-]/);
    if (parts.length > 1 && parts.every((x) => /^\d+$/.test(x))) {
      const nums = parts.map(Number);
      let y, m, d;
      if (parts[0].length === 4) [y, m, d] = nums;
      else [d, m, y] = nums;
      if (y != null && y < 100) y += 2000;
      tests.push((dt) => (y == null || dt.getFullYear() === y) && (m == null || dt.getMonth() === m - 1) && (d == null || dt.getDate() === d));
      continue;
    }
    if (/^(19|20)\d\d$/.test(tok)) {
      const y = Number(tok);
      tests.push((dt) => dt.getFullYear() === y);
      continue;
    }
    if (/^\d{1,2}$/.test(tok) && Number(tok) >= 1 && Number(tok) <= 31) {
      const d = Number(tok);
      tests.push((dt) => dt.getDate() === d);
      continue;
    }
    if (tok.length >= 3) {
      const m = MONTHS.findIndex((re) => re.test(tok));
      if (m >= 0) {
        tests.push((dt) => dt.getMonth() === m);
        continue;
      }
      const season = Object.keys(SEASONS).find((k) => tok.startsWith(k));
      if (season) {
        const ms = SEASONS[season];
        tests.push((dt) => ms.includes(dt.getMonth()));
        continue;
      }
    }
    words.push(tok);
  }
  return { tests, words };
}

const byDate = (items, tests) =>
  tests.length
    ? items.filter((it) => {
        const dt = new Date(it.t);
        return tests.every((t) => t(dt, it));
      })
    : items;

export class Search {
  constructor(root, { loader, onOpen, indexer }) {
    this.items = [];
    this.indexer = indexer;
    this.seq = 0;
    this.root = el('div', 'search-view');
    this.root.innerHTML = `
      <div class="view results scroller"></div>
      <div class="view suggest scroller"></div>
      <div class="search-empty" hidden>
        <div class="search-empty-title">Ничего не найдено</div>
        <div>Поиск понимает дату, месяц, год, время года, подпись к фото, альбом, имя файла, имена людей и то, что изображено на фото.</div>
        <div class="muted search-empty-ml"></div>
        <button class="big-btn" data-ml="enable" hidden>Включить умный поиск</button>
      </div>
      <header class="search-head">
        <div class="large-title">Поиск</div>
        <label class="search-field">
          <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          <input type="search" placeholder="Море, кот, июль 2024, имя…" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="clear" aria-label="Очистить" hidden>
            <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m8.5 8.5 7 7m0-7-7 7" stroke="var(--bg)" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </label>
        <div class="search-count"></div>
      </header>`;
    root.append(this.root);
    const q = (s) => this.root.querySelector(s);
    this.input = q('input');
    this.clearBtn = q('.clear');
    this.count = q('.search-count');
    this.resultsEl = q('.results');
    this.suggestEl = q('.suggest');
    this.emptyEl = q('.search-empty');
    this.grid = new Grid(this.resultsEl, { loader, onOpen: (i) => onOpen(this.results, i, this.grid) });
    this.results = [];

    this.input.addEventListener('input', () => {
      clearTimeout(this.t);
      this.t = setTimeout(() => this.run(), 120);
    });
    this.input.addEventListener('keydown', (e) => e.key === 'Enter' && this.input.blur());
    this.clearBtn.addEventListener('click', () => this.setQuery(''));
    this.suggestEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (b) this.setQuery(b.dataset.q);
    });
    // Прокрутка результатов прячет клавиатуру, как в iOS.
    this.resultsEl.addEventListener('touchstart', () => this.input.blur(), { passive: true });
    this.emptyEl.querySelector('[data-ml]').addEventListener('click', () => {
      indexer.enable();
      this.run(true);
    });
    indexer.addEventListener('progress', () => {
      if (this.waitingModel) this.count.textContent = this.modelText();
    });
    this.run();
  }

  setQuery(v) {
    this.input.value = v;
    this.run();
  }

  setItems(items) {
    this.items = items;
    this.renderSuggest();
    this.run(true);
  }

  modelText() {
    const m = this.indexer.models.text;
    return m < 1 ? `Загружаю модель поиска по смыслу… ${Math.round(m * 100)}%` : 'Ищу по содержимому…';
  }

  async run(keepScroll = false) {
    const query = this.input.value.trim();
    this.clearBtn.hidden = !query;
    const has = Boolean(query);
    this.resultsEl.classList.toggle('active', has);
    this.suggestEl.classList.toggle('active', !has);
    if (!has) {
      this.emptyEl.hidden = true;
      this.count.textContent = '';
      this.lastQuery = '';
      return;
    }
    if (query === this.lastQuery && keepScroll !== true) return;
    this.lastQuery = query;
    const my = ++this.seq;
    const ix = this.indexer;
    const { tests, words } = parseQuery(query);
    const base = byDate(this.items, tests);
    let results = base;
    let mode = 'plain';
    if (words.length) {
      // 1) имя файла / папки, 2) имя человека, 3) смысл картинки
      const byName = base.filter((it) => words.every((w) => textOf(it).includes(w)));
      const person = byName.length ? null : ix.findPerson(words.join(' '));
      if (byName.length) results = byName;
      else if (person) {
        const set = new Set(person.items.map((it) => it.p));
        results = base.filter((it) => set.has(it.p));
        mode = 'person';
      } else if (ix.enabled && ix.indexedCount) {
        mode = 'smart';
        this.waitingModel = true;
        this.count.textContent = this.modelText();
        this.emptyEl.hidden = true;
        try {
          results = await ix.semantic(words.join(' '), base);
        } catch (e) {
          results = [];
          this.smartError = e.message;
        }
        this.waitingModel = false;
      } else {
        results = [];
        mode = 'none';
      }
    }
    if (my !== this.seq) return;
    this.results = results;
    const n = results.length;
    let label = n ? `Найдено: ${photosCount(n)}` : '';
    if (n && mode === 'smart') {
      label = `По содержимому: ${photosCount(n)}`;
      if (ix.done < ix.total) label += ` · проанализировано ${ix.done.toLocaleString('ru')} из ${ix.total.toLocaleString('ru')}`;
    }
    if (n && mode === 'person') label = `${photosCount(n)} с этим человеком`;
    this.count.textContent = label;
    this.emptyEl.hidden = n > 0;
    if (!n) {
      const mlBtn = this.emptyEl.querySelector('[data-ml]');
      const mlText = this.emptyEl.querySelector('.search-empty-ml');
      mlBtn.hidden = ix.enabled;
      mlText.textContent = !ix.enabled
        ? 'Чтобы искать по содержимому («море», «кошка», «торт»), включите умный поиск: фото проанализируются прямо на телефоне.'
        : ix.indexedCount < ix.total
          ? `Фото ещё анализируются: ${ix.done.toLocaleString('ru')} из ${ix.total.toLocaleString('ru')}. Попробуйте позже.`
          : '';
    }
    this.grid.setItems(results, { reset: keepScroll !== true });
  }

  renderSuggest() {
    const years = new Map();
    const folders = new Map();
    for (const it of this.items) {
      const y = new Date(it.t).getFullYear();
      years.set(y, (years.get(y) || 0) + 1);
      const f = it.p.replace(/^disk:\//, '').split('/').slice(0, -1).join('/');
      if (f) folders.set(f, (folders.get(f) || 0) + 1);
    }
    const now = new Date();
    const chips = [
      ['Этот месяц', `${monthLabel(now.getFullYear(), now.getMonth()).toLowerCase()} ${now.getFullYear()}`],
      ['Лето', 'лето'],
      ['Зима', 'зима'],
      ['Новый год', '31.12'],
    ];
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const topFolders = [...folders].sort((a, b) => b[1] - a[1]).slice(0, 8);
    this.suggestEl.innerHTML = `
      <div class="suggest-inner">
        <div class="group-title">Быстрый поиск</div>
        <div class="chips">${chips.map(([l, v]) => `<button class="chip" data-q="${esc(v)}">${l}</button>`).join('')}</div>
        <div class="group-title">Годы</div>
        <div class="chips">${[...years].sort((a, b) => b[0] - a[0]).map(([y, n]) => `<button class="chip" data-q="${y}">${y}<span>${n.toLocaleString('ru')}</span></button>`).join('')}</div>
        ${topFolders.length ? `<div class="group-title">Альбомы</div><div class="group">${topFolders
          .map(([f, n]) => `<button class="row" data-q="${esc(f.split('/').pop())}"><span>${esc(f)}</span><span class="muted">${n.toLocaleString('ru')}</span></button>`)
          .join('')}</div>` : ''}
        <div class="group-foot">Можно сочетать: «море 2024», «июль», «12.05», «лето сочи», имя человека, «IMG_45».</div>
      </div>`;
  }
}
