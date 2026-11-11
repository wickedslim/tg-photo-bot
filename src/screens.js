// Настройки (шторка), автозагрузка, экраны-заглушки и всплывающие сообщения.
import { pushBack, haptic, openExternal, isIOS } from './tg.js';
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
    <div class="group-foot">«Быстрые команды» сами отправляют новые фото в галерею, когда вы открываете Telegram и телефон подключён к Wi‑Fi.</div>
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
      <div class="row">Все фото лежат в вашем личном чате с ботом. Удаляйте их корзиной в галерее — так фото пропадёт и из галереи, и из чата. Главная галерея — «Фото» на iPhone: лишний снимок сначала удалите там, иначе автозагрузка может прислать свежее фото снова.</div>
      <div class="row">Другие пользователи бота ваши фото не видят.</div>
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
export const SHORTCUT_LINK = 'https://www.icloud.com/shortcuts/f1c689a10ddb41cdb41788041c603f59';
// Версия команды по этой ссылке. Меняйте вместе со ссылкой: у кого команда старее, галерея предложит обновить.
export const SHORTCUT_VERSION = 2;
// Страница, которая открывает «Команды» и запускает «Фото в Telegram». Из Telegram нельзя открыть
// адрес shortcuts:// напрямую — только обычную ссылку, поэтому идём через свою страницу (public/run.html).
const RUN_PAGE = new URL('run.html', location.href.split('#')[0]).href;
const day = (ms) => fmtDay.format(ms).replace(/ г\.$/, '');
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function showAutoUpload({ api }) {
  const s = openSheet('Автозагрузка с iPhone', '<div class="auto-body"><div class="empty-inline"><span class="spinner small"></span></div></div>');
  const body = s.q('.auto-body');
  let settings = { original: false, archive: false, wifiOnly: true };
  let info = null;

  const copyRow = (label, value) => `
    <div class="copy-row"><div class="copy-label">${esc(label)}</div>
      <div class="copy-line"><input readonly value="${esc(value)}" spellcheck="false"><button class="text-btn copy" data-v="${esc(value)}">Копировать</button></div></div>`;

  // Автоматизацию ссылкой не передать (так устроены «Команды») — её человек делает сам, это 6 нажатий.
  const automation = `
    <div class="group-title">Запускать автоматически</div>
    <ol class="steps">
      <li>Откройте «Команды» → вкладка <b>«Автоматизация»</b> → <b>«+»</b>.</li>
      <li><b>«Приложение»</b> → выберите <b>«Telegram»</b> → отметьте <b>«Открыто»</b> → <b>«Запускать сразу»</b> → <b>«Далее»</b> → <b>«Новая пустая автоматизация»</b>.</li>
      ${
        SHORTCUT_VERSION >= 2
          ? '<li>Добавьте действие <b>«Запустить команду»</b> → <b>«Фото в Telegram»</b>.</li>'
          : `<li>Добавьте действие <b>«Получить сведения о сети»</b>: сеть <b>«Wi‑Fi»</b>, сведения <b>«Имя сети»</b>.</li>
      <li>Добавьте действие <b>«Если»</b>: <b>«Сведения о сети»</b> → <b>«имеет любое значение»</b>.</li>
      <li>Внутрь «Если» добавьте действие <b>«Запустить команду»</b> → <b>«Фото в Telegram»</b>.</li>`
      }
      <li>Один раз: «Настройки» → «Приложения» → «Команды» → «Дополнительно» → включите <b>«Разрешить отправку больших объёмов данных»</b>. Без этого iPhone пропускает за раз только одно фото.</li>
    </ol>
    <div class="group-foot">Новые снимки уходят, когда вы открываете Telegram${SHORTCUT_VERSION >= 2 ? ' (по мобильной сети — только если выключить «Только по Wi‑Fi»)' : ' и телефон подключён к Wi‑Fi'}. Новые снимки проверяются раз в 12 часов, чтобы не нагружать телефон. Не блокируйте телефон, пока идёт отправка: на заблокированном экране iPhone её прерывает. В первый раз iPhone спросит, можно ли отправлять фото на сервер, — ответьте <b>«Разрешать всегда»</b>.</div>`;

  // Последний запуск. Дошёл ли он до конца, знает только команда версии 2: она сообщает об этом серверу.
  const runState = (r) => {
    if (!r || r.version < 2) return '';
    if (r.done) return ' · завершён';
    return Date.now() - r.at < 10 * 60000 ? ' · идёт' : ' · прервался';
  };
  const statusRows = (k) => `
    <div class="group">
      <div class="row"><span>Последний запуск</span><span class="muted">${k.run?.at ? fmtWhen.format(k.run.at) + runState(k.run) : k.used ? fmtWhen.format(k.used) : 'ещё не было'}</span></div>
      <div class="row"><span>Последняя загрузка</span><span class="muted">${k.used ? fmtWhen.format(k.used) : '—'}</span></div>
    </div>`;

  // Команда старее той, что по ссылке: предлагаем поставить новую (с новым ключом — старый в ней не сохранить).
  const updateBlock = (k) => {
    if (!SHORTCUT_LINK || !k.run || k.run.version >= SHORTCUT_VERSION) return '';
    return `
      <div class="notice">Вышла новая версия команды «Фото в Telegram»: она сама пропускает снимки, на которых iPhone зависает, не тратит время на видео и уже загруженное и умеет «Только по Wi‑Fi».</div>
      <ol class="steps">
        <li>В «Командах» удалите старую команду «Фото в Telegram».</li>
        <li>Нажмите <b>«Обновить команду»</b> ниже и добавьте новую — ключ скопируется сам.</li>
        <li>В автоматизации «Telegram» оставьте одно действие: <b>«Запустить команду»</b> → <b>«Фото в Telegram»</b> (проверка Wi‑Fi теперь в настройках ниже).</li>
      </ol>
      <div class="group"><button class="row link" id="update">Обновить команду</button></div>
      <div class="group-foot">Загрузка продолжится с того же места, повторов не будет.</div>`;
  };

  // Снимки, на которых iPhone зависал: сервер их пропустил, чтобы не вставали остальные.
  const skippedBlock = (k) => {
    if (!k.skipped?.length) return '';
    return `
      <div class="group-title">Пропущены — iPhone на них зависал</div>
      <div class="group">${k.skipped.map((x) => `<div class="row"><span>${esc(x.text)}</span></div>`).join('')}</div>
      <div class="group-foot">Если какой-то из этих снимков нужен — найдите его в «Фото» по дате и добавьте вручную кнопкой «+» в галерее.</div>`;
  };

  const archiveRows = (a) => {
    if (!a) return '<div class="row"><span>Старые фото</span><span class="muted">ещё не начали</span></div>';
    // «Дошли до» можно поменять: вперёд — перешагнуть снимки, назад — пройти заново (повторов не будет).
    return `
      <div class="row"><span>Загружено старых</span><span class="muted">${(a.count || 0).toLocaleString('ru')} фото</span></div>
      ${a.done ? '<div class="row"><span>Готово</span><span class="muted">всё загружено</span></div>' : ''}
      <label class="row"><span>${a.done ? 'Пройти заново с' : 'Дошли до'}</span><input type="date" class="date-input" id="skip-date" value="${a.cursor != null && !a.done ? ymd(a.cursor) : ''}" min="1990-01-01" max="${ymd(Date.now())}"></label>
      <button class="row link" id="skip" hidden>Продолжить с этой даты</button>`;
  };

  // Архив застрял: сервер видит, что запуски доходят до него, а отметка больше суток стоит на месте.
  // Перешагнуть это место решает человек — датой в «Дошли до».
  const stuckBlock = (a) => {
    if (!a?.stuck || a.cursor == null) return '';
    return `
      <div class="notice stuck">Старые фото не загружаются больше суток: архив стоит на <b>${day(a.cursor)}</b>. Похоже, iPhone зависает на снимке сразу после этой даты. Поставьте в «Дошли до» дату позже — снимки до неё архив пропустит, нужные можно добавить вручную кнопкой «+».</div>`;
  };

  // Настройки хранятся на сервере, команда спрашивает их перед каждым запуском — менять её не нужно.
  const settingsBlock = () => `<div class="auto-settings">${settingsHtml()}</div>`;
  const settingsHtml = () => `
    <div class="group-title">Настройки</div>
    <div class="group">
      <label class="row switch-row"><span>Оригиналы без сжатия</span><input type="checkbox" class="switch" data-k="original" ${settings.original ? 'checked' : ''}></label>
      <label class="row switch-row"><span>Загрузить старые фото</span><input type="checkbox" class="switch" data-k="archive" ${settings.archive ? 'checked' : ''}></label>
      ${settings.archive ? archiveRows(info?.archive) : ''}
      ${SHORTCUT_VERSION >= 2 ? `<label class="row switch-row"><span>Только по Wi‑Fi</span><input type="checkbox" class="switch" data-k="wifiOnly" ${settings.wifiOnly !== false ? 'checked' : ''}></label>` : ''}
    </div>
    <div class="group-foot">${
      settings.original
        ? 'Фото уходят файлом в исходном качестве (HEIC, как снял iPhone): дольше загружаются, зато ничего не теряется.'
        : 'Фото сжимаются на телефоне до 2560 px, как обычные фото в Telegram: так загрузка быстрее.'
    } ${
      settings.archive
        ? 'Сначала загружаются новые снимки, а когда новых нет — старые, от самых старых, по 100 за запуск. Чтобы быстрее — поставьте телефон на зарядку и запустите команду вручную несколько раз. Повторов не будет. Дату «Дошли до» можно поменять: позже — пропустить снимки до неё, раньше — пройти заново.'
        : 'Без старых фото загружаются только снимки, сделанные после подключения.'
    } ${
      SHORTCUT_VERSION < 2
        ? ''
        : settings.wifiOnly !== false
        ? 'По мобильной сети фото не уходят — кроме «Загрузить сейчас».'
        : 'Фото уходят и по мобильной сети — следите за трафиком, особенно с оригиналами.'
    }</div>
    ${settings.archive ? stuckBlock(info?.archive) : ''}`;

  const redrawSettings = () => {
    body.querySelector('.auto-settings').innerHTML = settingsHtml();
    wireSwitches();
  };

  const wireSwitches = () => {
    body.querySelector('#skip-date')?.addEventListener('change', () => {
      const btn = body.querySelector('#skip');
      if (btn) btn.hidden = false;
    });
    body.querySelector('#skip')?.addEventListener('click', async (e) => {
      const [y, m, d] = (body.querySelector('#skip-date')?.value || '').split('-').map(Number);
      if (!y) return toast('Выберите дату');
      e.currentTarget.disabled = true;
      try {
        const r = await api.skipArchive(new Date(y, m - 1, d).getTime());
        info = { ...info, archive: r.archive };
        haptic('medium');
        toast(`Архив продолжится с ${day(r.archive.cursor)}`);
      } catch (err) {
        toast(err.message);
      }
      redrawSettings();
    });
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
        redrawSettings();
      }),
    );
  };

  // Ключ показывается один раз: сразу после создания предлагаем добавить с ним команду.
  const renderConnect = (k) => {
    const key = 'Key ' + k.key;
    body.innerHTML = SHORTCUT_LINK
      ? `
        <div class="group-title">1. Добавьте команду</div>
        <button class="big-btn" id="add" data-v="${esc(key)}">Добавить команду</button>
        <div class="setup-hint">Ключ скопируется сам. Когда iPhone спросит ключ, нажмите на поле → <b>«Вставить»</b> → <b>«Добавить команду»</b>. Если старая команда «Фото в Telegram» ещё есть — сначала удалите её, иначе новая получит другое имя.</div>
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
        <div class="group-foot first">Приложение не может само заглянуть в галерею телефона — так устроены iPhone. Зато это умеют встроенные «Быстрые команды»: когда вы открываете Telegram и телефон подключён к Wi‑Fi, они сами отправят новые фото сюда.</div>
        <button class="big-btn" id="create">Подключить автозагрузку</button>
        <div class="setup-hint">Займёт пару минут: добавить готовую команду и сделать автоматизацию. Вы получите личный ключ — по нему можно только загружать фото в ваш чат, смотреть их нельзя.</div>`;
    } else {
      body.innerHTML = `
        ${updateBlock(k)}
        ${statusRows(k)}
        <div class="group"><button class="row link" id="now">Загрузить сейчас</button></div>
        <div class="group-foot">${
          isIOS
            ? 'Снимает паузу в 12 часов и сразу запускает команду «Фото в Telegram» — iPhone спросит, открыть ли «Команды». Если вы переименовали команду, верните ей это название.'
            : 'Снимает паузу в 12 часов: новые снимки уйдут при следующем открытии Telegram на iPhone.'
        }</div>
        ${settingsBlock()}
        ${skippedBlock(k)}
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
    body.querySelector('#now')?.addEventListener('click', async () => {
      try {
        await api.uploadNow();
        haptic('light');
        // Сначала сервер снимает паузу, потом iPhone запускает команду — иначе она получила бы «ничего не делать».
        if (isIOS) openExternal(RUN_PAGE);
        else toast('Готово. Новые снимки уйдут при следующем открытии Telegram на iPhone');
      } catch (err) {
        toast(err.message);
      }
    });
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
    body.querySelector('#update')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        renderConnect(await api.createAutoKey());
        haptic('medium');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
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
