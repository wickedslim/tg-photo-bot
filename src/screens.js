// Настройки (шторка), автозагрузка, экраны-заглушки и всплывающие сообщения.
import { pushBack, haptic, openExternal } from './tg.js';
import { storageUsage } from './store.js';
import { photosCount } from './grid.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${Math.round(b / 1e6)} МБ`);
const fmtWhen = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const GUIDE_URL = 'https://github.com/wickedslim/tg-photo-bot/blob/main/docs/shortcut.md';

export function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

export function showMessage(root, { title, text }) {
  root.innerHTML = `<div class="setup"><div class="setup-hero">${icon()}<h1>${esc(title)}</h1><p>${esc(text)}</p></div></div>`;
}

export const icon = () =>
  '<div class="app-icon"><svg viewBox="0 0 64 64" width="72" height="72"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ac8fa"/><stop offset=".55" stop-color="#2a9df4"/><stop offset="1" stop-color="#5856d6"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/><path d="M15 44 26 31l8 9 6-6 9 10Z" fill="#fff"/><circle cx="42" cy="22" r="5" fill="#fff"/></svg></div>';

// Окошко с полем ввода в стиле iOS (window.prompt в Telegram работает не везде).
export function askText({ title, message = '', value = '', placeholder = '', ok = 'Готово' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'alert-wrap';
    wrap.innerHTML = `
      <div class="alert">
        <div class="alert-title">${esc(title)}</div>
        ${message ? `<div class="alert-msg">${esc(message)}</div>` : ''}
        <input class="alert-input" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done">
        <div class="alert-btns"><button data-r="cancel">Отмена</button><button data-r="ok" class="bold">${esc(ok)}</button></div>
      </div>`;
    document.body.append(wrap);
    const input = wrap.querySelector('input');
    requestAnimationFrame(() => {
      wrap.classList.add('open');
      input.focus();
      input.select();
    });
    let popBack = () => {};
    const done = (v) => {
      popBack();
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 200);
      resolve(v);
    };
    popBack = pushBack(() => done(null));
    wrap.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r) done(r === 'ok' ? input.value : null);
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && done(input.value));
  });
}

function openSheet(title, html) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `
    <div class="sheet-bg"></div>
    <div class="sheet scroller">
      <div class="sheet-head"><div class="sheet-grab"></div><h2>${esc(title)}</h2><button class="text-btn done">Готово</button></div>
      ${html}
    </div>`;
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  let popBack = () => {};
  const close = () => {
    popBack();
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 350);
  };
  popBack = pushBack(close);
  wrap.querySelector('.sheet-bg').addEventListener('click', close);
  wrap.querySelector('.done').addEventListener('click', close);
  return { el: wrap, q: (s) => wrap.querySelector(s), close };
}

export function showSettings({ disk, count, indexer, onAuto, onReindex, onClearCache, onWipe }) {
  const s = openSheet(
    'Настройки',
    `
    <div class="group">
      <div class="row"><span>Аккаунт</span><span class="muted" id="acc">…</span></div>
      <div class="row"><span>В галерее</span><span class="muted">${photosCount(count)}</span></div>
    </div>
    <div class="group-title">Автозагрузка</div>
    <div class="group">
      <button class="row link" id="auto">Автозагрузка с iPhone</button>
    </div>
    <div class="group-foot">«Быстрые команды» сами отправляют новые фото в галерею — после съёмки и каждый вечер.</div>
    <div class="group">
      <button class="row link" id="reindex">Обновить список фото</button>
      <button class="row link" id="clear">Очистить кэш миниатюр <span class="muted" id="usage"></span></button>
    </div>
    <div class="group-title">Люди и умный поиск</div>
    <div class="group">
      <div class="row"><span>Анализ фото</span><span class="muted">${indexer.enabled ? `${indexer.done.toLocaleString('ru')} из ${indexer.total.toLocaleString('ru')}` : 'выключен'}</span></div>
      <button class="row link ${indexer.enabled ? 'danger' : ''}" id="ml">${indexer.enabled ? 'Выключить и удалить результаты анализа' : 'Включить'}</button>
    </div>
    <div class="group-foot">Лица и содержимое фото анализируются только на этом устройстве. Имена людей тоже хранятся здесь.</div>
    <div class="group-title">Где хранятся фото</div>
    <div class="group about">
      <div class="row">Все фото лежат в вашем личном чате с ботом. Удалите сообщение в чате — фото пропадёт и из Telegram.</div>
      <div class="row">Другие пользователи бота ваши фото не видят. Но владелец бота технически может получить к ним доступ — не загружайте то, что хотите скрыть ото всех.</div>
    </div>
    <div class="group">
      <button class="row link danger" id="wipe">Стереть данные галереи на этом устройстве</button>
    </div>
    <div class="group-foot">Миниатюры, избранное, люди и их имена. Сами фото останутся в чате с ботом.</div>`,
  );
  const q = s.q;
  q('#auto').addEventListener('click', () => {
    s.close();
    onAuto();
  });
  q('#reindex').addEventListener('click', () => {
    s.close();
    onReindex();
  });
  q('#clear').addEventListener('click', async () => {
    await onClearCache();
    q('#usage').textContent = fmtBytes(await storageUsage());
    toast('Кэш очищен');
  });
  q('#ml').addEventListener('click', async () => {
    if (indexer.enabled) {
      await indexer.disable();
      toast('Анализ выключен, данные удалены');
    } else {
      indexer.enable();
      toast('Анализ включён');
    }
    s.close();
  });
  q('#wipe').addEventListener('click', () => {
    s.close();
    onWipe();
  });
  disk.me().then((m) => (q('#acc').textContent = m.name || '—'), () => (q('#acc').textContent = '—'));
  storageUsage().then((u) => (q('#usage').textContent = fmtBytes(u)));
}

// ── Автозагрузка с iPhone: личный ключ для «Быстрых команд» ──
export async function showAutoUpload({ api }) {
  const s = openSheet('Автозагрузка с iPhone', '<div class="auto-body"><div class="empty-inline"><span class="spinner small"></span></div></div>');
  const body = s.q('.auto-body');

  const copyRow = (label, value) => `
    <div class="copy-row"><div class="copy-label">${esc(label)}</div>
      <div class="copy-line"><input readonly value="${esc(value)}" spellcheck="false"><button class="text-btn copy" data-v="${esc(value)}">Копировать</button></div></div>`;

  const steps = `
    <div class="group-title">Как настроить (один раз)</div>
    <ol class="steps">
      <li>Откройте приложение <b>«Команды»</b> → вкладка <b>«Автоматизация»</b> → <b>«+»</b>.</li>
      <li>Выберите <b>«Приложение»</b> → <b>«Камера»</b> → отметьте <b>«Закрыто»</b> → <b>«Запускать сразу»</b>.</li>
      <li>Соберите команду из пяти шагов по <a href="#" id="guide">подробной инструкции</a> — туда нужно вставить адреса и ключ отсюда.</li>
      <li>Сделайте вторую автоматизацию <b>«Время суток»</b> → 23:00 с той же командой — на случай, если первая не сработала.</li>
    </ol>
    <div class="group-foot">Запуск по расписанию iOS иногда пропускает, особенно когда телефон заблокирован. Ничего не потеряется: следующий запуск догрузит всё, что не дошло. За раз уходит до 30 фото.</div>`;

  const renderKey = (k) => {
    body.innerHTML = `
      <div class="notice">Ключ показывается один раз. Сохраните его в команду сейчас. Потеряли — создайте новый, старый перестанет работать.</div>
      ${copyRow('Ключ', 'Key ' + k.key)}
      ${copyRow('Адрес загрузки', k.uploadUrl)}
      ${copyRow('Адрес «с какой даты»', k.sinceUrl)}
      ${steps}
      <div class="group"><button class="row link danger" id="off">Отключить автозагрузку</button></div>`;
    wire();
  };

  const renderInfo = (info) => {
    if (!info.exists) {
      body.innerHTML = `
        <div class="group-foot first">Приложение не может само заглянуть в галерею телефона — так устроены iPhone. Зато это умеют встроенные «Быстрые команды»: после съёмки и каждый вечер они отправят новые фото сюда, без ваших нажатий.</div>
        <button class="big-btn" id="create">Включить автозагрузку</button>
        <div class="setup-hint">Вы получите личный ключ. По нему можно только загружать фото в ваш чат — смотреть фото по нему нельзя.</div>
        ${steps}`;
    } else {
      body.innerHTML = `
        <div class="group">
          <div class="row"><span>Ключ создан</span><span class="muted">${fmtWhen.format(info.created)}</span></div>
          <div class="row"><span>Последний запуск</span><span class="muted">${info.used ? fmtWhen.format(info.used) : 'ещё не было'}</span></div>
          <div class="row"><span>Последнее фото снято</span><span class="muted">${info.cursor ? fmtWhen.format(info.cursor) : '—'}</span></div>
        </div>
        ${copyRow('Адрес загрузки', info.base + '/api/upload')}
        ${copyRow('Адрес «с какой даты»', info.base + '/api/auto/since')}
        ${steps}
        <div class="group">
          <button class="row link" id="create">Создать новый ключ</button>
          <button class="row link danger" id="off">Отключить автозагрузку</button>
        </div>`;
    }
    wire();
  };

  const wire = () => {
    body.querySelectorAll('.copy').forEach((b) =>
      b.addEventListener('click', async () => {
        const input = b.previousElementSibling;
        try {
          await navigator.clipboard.writeText(b.dataset.v);
        } catch {
          input.select();
          document.execCommand?.('copy');
        }
        haptic('light');
        toast('Скопировано');
      }),
    );
    body.querySelector('#guide')?.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(GUIDE_URL);
    });
    body.querySelector('#create')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        renderKey(await api.createAutoKey());
        haptic('medium');
      } catch (err) {
        toast(err.message);
        e.target.disabled = false;
      }
    });
    body.querySelector('#off')?.addEventListener('click', async () => {
      try {
        await api.deleteAutoKey();
        toast('Автозагрузка отключена');
        renderInfo({ exists: false });
      } catch (err) {
        toast(err.message);
      }
    });
  };

  try {
    renderInfo(await api.autoKeyInfo());
  } catch (e) {
    body.innerHTML = `<div class="empty-inline">${esc(e.message)}</div>`;
  }
}
