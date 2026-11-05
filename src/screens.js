// Настройки (шторка), автозагрузка, экраны-заглушки и всплывающие сообщения.
import { pushBack, haptic, openExternal } from './tg.js';
import { storageUsage } from './store.js';
import { photosCount } from './grid.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : `${Math.round(b / 1e6)} МБ`);
const fmtWhen = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const GUIDE_URL = 'https://github.com/wickedslim/tg-photo-bot/blob/main/docs/shortcut.md';
const fmtDay = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });

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

// ── Автозагрузка с iPhone: личный ключ и готовая «Быстрая команда» ──
// Ссылка iCloud на готовую команду «Фото в Telegram» (как её получить — docs/shortcut.md). Пока ссылки нет,
// экран предлагает собрать команду по инструкции.
export const SHORTCUT_LINK = '';

export async function showAutoUpload({ api }) {
  const s = openSheet('Автозагрузка с iPhone', '<div class="auto-body"><div class="empty-inline"><span class="spinner small"></span></div></div>');
  const body = s.q('.auto-body');
  let settings = { original: false, archive: false };
  let info = null;

  const copyRow = (label, value) => `
    <div class="copy-row"><div class="copy-label">${esc(label)}</div>
      <div class="copy-line"><input readonly value="${esc(value)}" spellcheck="false"><button class="text-btn copy" data-v="${esc(value)}">Копировать</button></div></div>`;

  // Автоматизацию ссылкой не передать (так устроены «Команды») — её человек делает сам, это 6 нажатий.
  const automation = `
    <div class="group-title">Запускать автоматически</div>
    <ol class="steps">
      <li>Откройте «Команды» → вкладка <b>«Автоматизация»</b> → <b>«+»</b>.</li>
      <li><b>«Приложение»</b> → выберите <b>«Камера»</b> → отметьте <b>«Закрыто»</b> (снимите «Открыто») → <b>«Запускать сразу»</b> → <b>«Далее»</b> → команда <b>«Фото в Telegram»</b>.</li>
      <li>Ещё одну: <b>«Зарядное устройство»</b> → <b>«Подключено»</b> → <b>«Запускать сразу»</b> → та же команда.</li>
      <li>Один раз: «Настройки» → «Приложения» → «Команды» → «Дополнительно» → включите <b>«Разрешить отправку больших объёмов данных»</b>. Без этого iPhone пропускает за раз только одно фото.</li>
    </ol>
    <div class="group-foot">Первая автоматизация отправляет снимки, как только вы выходите из камеры, вторая догружает остальное, когда вы ставите телефон на зарядку. В первый раз iPhone спросит, можно ли отправлять фото на сервер, — ответьте <b>«Разрешать всегда»</b>.</div>`;

  const statusRows = (k) => `
    <div class="group">
      <div class="row"><span>Последний запуск</span><span class="muted">${k.used ? fmtWhen.format(k.used) : 'ещё не было'}</span></div>
      <div class="row"><span>Последнее фото снято</span><span class="muted">${k.cursor ? fmtWhen.format(k.cursor) : '—'}</span></div>
    </div>`;

  const archiveRows = (a) => {
    if (!a) return '<div class="row"><span>Старые фото</span><span class="muted">ещё не начали</span></div>';
    return `
      <div class="row"><span>Загружено старых</span><span class="muted">${(a.count || 0).toLocaleString('ru')} фото</span></div>
      <div class="row"><span>${a.done ? 'Готово' : 'Дошли до'}</span><span class="muted">${a.done ? 'всё загружено' : a.cursor != null ? fmtDay.format(a.cursor).replace(/ г\.$/, '') : '—'}</span></div>`;
  };

  // Настройки хранятся на сервере, команда спрашивает их перед каждым запуском — менять её не нужно.
  const settingsBlock = () => `<div class="auto-settings">${settingsHtml()}</div>`;
  const settingsHtml = () => `
    <div class="group-title">Настройки</div>
    <div class="group">
      <label class="row switch-row"><span>Оригиналы без сжатия</span><input type="checkbox" class="switch" data-k="original" ${settings.original ? 'checked' : ''}></label>
      <label class="row switch-row"><span>Загрузить и старые фото</span><input type="checkbox" class="switch" data-k="archive" ${settings.archive ? 'checked' : ''}></label>
      ${settings.archive ? archiveRows(info?.archive) : ''}
    </div>
    <div class="group-foot">${
      settings.original
        ? 'Фото уходят файлом в исходном качестве (HEIC, как снял iPhone): дольше загружаются, зато ничего не теряется.'
        : 'Фото сжимаются на телефоне до 2560 px, как обычные фото в Telegram: так загрузка быстрее.'
    } ${
      settings.archive
        ? 'Старые фото идут по порядку, от самых старых, по 100 за запуск, вперемешку с новыми. Чтобы быстрее — поставьте телефон на зарядку и запустите команду вручную несколько раз. Повторов не будет.'
        : 'Без старых фото загружаются только снимки, сделанные после подключения.'
    }</div>`;

  const wireSwitches = () =>
    body.querySelectorAll('.switch').forEach((sw) =>
      sw.addEventListener('change', async () => {
        const prev = settings;
        settings = { ...settings, [sw.dataset.k]: sw.checked };
        try {
          settings = (await api.saveAutoSettings(settings)).settings || settings;
          haptic('light');
        } catch (err) {
          settings = prev;
          toast(err.message);
        }
        // Перерисовываем только настройки: подписи и прогресс старых фото зависят от переключателей.
        body.querySelector('.auto-settings').innerHTML = settingsHtml();
        wireSwitches();
      }),
    );

  // Ключ показывается один раз: сразу после создания предлагаем добавить с ним команду.
  const renderConnect = (k) => {
    const key = 'Key ' + k.key;
    body.innerHTML = SHORTCUT_LINK
      ? `
        <div class="group-title">1. Добавьте команду</div>
        <button class="big-btn" id="add" data-v="${esc(key)}">Добавить команду</button>
        <div class="setup-hint">Ключ скопируется сам. Когда iPhone спросит ключ, нажмите на поле → <b>«Вставить»</b> → <b>«Добавить команду»</b>.</div>
        ${copyRow('Ключ (если не вставился)', key)}
        ${automation.replace('Запускать автоматически', '2. Запускать автоматически')}
        ${settingsBlock()}
        <div class="group"><button class="row link danger" id="off">Отключить автозагрузку</button></div>`
      : `
        <div class="notice">Ключ показывается один раз. Сохраните его в команду сейчас. Потеряли — подключите заново, старый ключ перестанет работать.</div>
        ${copyRow('Ключ', key)}
        ${copyRow('Адрес задания', k.nextUrl)}
        <div class="group-foot">Соберите команду «Фото в Telegram» по <a href="#" id="guide">инструкции</a> и вставьте туда ключ и адрес.</div>
        ${automation}
        ${settingsBlock()}
        <div class="group"><button class="row link danger" id="off">Отключить автозагрузку</button></div>`;
    wire();
  };

  const renderInfo = (k) => {
    info = k;
    settings = k.settings || settings;
    if (!k.exists) {
      body.innerHTML = `
        <div class="group-foot first">Приложение не может само заглянуть в галерею телефона — так устроены iPhone. Зато это умеют встроенные «Быстрые команды»: после съёмки и на зарядке они сами отправят новые фото сюда.</div>
        <button class="big-btn" id="create">Подключить автозагрузку</button>
        <div class="setup-hint">Займёт пару минут: добавить готовую команду и сделать две автоматизации. Вы получите личный ключ — по нему можно только загружать фото в ваш чат, смотреть их нельзя.</div>`;
    } else {
      body.innerHTML = `
        ${statusRows(k)}
        ${settingsBlock()}
        ${automation}
        <div class="group">
          <button class="row link" id="create">Подключить заново (новый ключ)</button>
          <button class="row link danger" id="off">Отключить автозагрузку</button>
        </div>
        <div class="group-foot">Подключить заново — если команда пропала или вы поменяли iPhone. Старый ключ перестанет работать, загрузка продолжится с того же места.</div>`;
    }
    wire();
  };

  const copy = async (text, input) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      if (!input) return false;
      input.select();
      return Boolean(document.execCommand?.('copy'));
    }
  };

  const wire = () => {
    body.querySelectorAll('.copy').forEach((b) =>
      b.addEventListener('click', async () => {
        await copy(b.dataset.v, b.previousElementSibling);
        haptic('light');
        toast('Скопировано');
      }),
    );
    body.querySelector('#add')?.addEventListener('click', (e) => {
      // Сначала копируем (пока нажатие «свежее» — иначе iPhone не даст писать в буфер), потом открываем ссылку.
      copy(e.currentTarget.dataset.v, body.querySelector('.copy-line input'));
      haptic('medium');
      setTimeout(() => openExternal(SHORTCUT_LINK), 150);
    });
    body.querySelector('#guide')?.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(GUIDE_URL);
    });
    wireSwitches();
    body.querySelector('#create')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        renderConnect(await api.createAutoKey());
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
        renderInfo({ exists: false, settings });
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
