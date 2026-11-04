// Обёртка над Telegram WebApp API. Приложение работает и в обычном браузере (для отладки).
export const tg = window.Telegram?.WebApp;
export const inTelegram = Boolean(tg && tg.initData);

const can = (v) => inTelegram && tg.isVersionAtLeast?.(v);

// Тема — дневная/ночная по настройке устройства. Переключателя в приложении нет намеренно.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function initTelegram() {
  applyTheme();
  // Телефон сам перешёл в ночной режим (по расписанию или вручную) — перекрашиваемся на лету.
  darkQuery.addEventListener('change', applyTheme);
  if (!inTelegram) return;
  setupInsets();
  tg.ready();
  tg.expand();
  if (can('7.7')) tg.disableVerticalSwipes();
  // На телефонах — полноэкранный режим, как у нативного приложения (если Telegram ещё не открыл так сам).
  if (can('8.0') && ['ios', 'android'].includes(tg.platform) && !tg.isFullscreen) {
    try { tg.requestFullscreen(); } catch {}
  }
  tg.onEvent('themeChanged', applyTheme);
}

// Отступы сверху/снизу (вырез экрана и кнопки Telegram) приходят от Telegram не сразу, а через мгновение
// после запуска — без мер интерфейс сначала рисуется впритык к краю, а потом «прыгает» вниз.
// Поэтому на время запуска подставляем отступы, запомненные с прошлого раза.
function setupInsets() {
  const root = document.documentElement.style;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem('tg-insets'));
  } catch {}
  if (cached) {
    root.setProperty('--boot-top', cached.top + 'px');
    root.setProperty('--boot-bottom', cached.bottom + 'px');
  }
  const got = new Set();
  const finish = () => {
    if (!root.getPropertyValue('--boot-top')) return;
    root.removeProperty('--boot-top');
    root.removeProperty('--boot-bottom');
    window.dispatchEvent(new Event('insetschange'));
  };
  const timer = setTimeout(finish, 1500);
  const onChange = (name) => () => {
    got.add(name);
    const s = tg.safeAreaInset || {};
    const c = tg.contentSafeAreaInset || {};
    const v = { top: (s.top || 0) + (c.top || 0), bottom: Math.max(s.bottom || 0, c.bottom || 0) };
    if (got.size === 2) {
      clearTimeout(timer);
      finish();
      localStorage.setItem('tg-insets', JSON.stringify(v));
    }
    window.dispatchEvent(new Event('insetschange'));
  };
  tg.onEvent('safeAreaChanged', onChange('safe'));
  tg.onEvent('contentSafeAreaChanged', onChange('content'));
}

export function isDark() {
  return darkQuery.matches;
}

export function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const bg = dark ? '#000000' : '#ffffff';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  if (inTelegram) {
    try {
      tg.setHeaderColor(bg);
      tg.setBackgroundColor(bg);
      if (can('7.10')) tg.setBottomBarColor(bg);
    } catch {}
  }
}

// ── Хранилище: Telegram CloudStorage (синхронизируется между устройствами) или localStorage ──
const useCloud = can('6.9');

export const storage = {
  get(key) {
    if (!useCloud) return Promise.resolve(localStorage.getItem(key));
    return new Promise((resolve) => {
      tg.CloudStorage.getItem(key, (err, value) => {
        if (err || !value) return resolve(localStorage.getItem(key));
        localStorage.removeItem(key); // в облаке есть — локальная копия (от старых версий) не нужна
        resolve(value);
      });
    });
  },
  // В Telegram пишем только в CloudStorage: на github.io адрес сайта общий для всех проектов
  // владельца, и лишняя копия токена в localStorage ни к чему.
  set(key, value) {
    if (!useCloud) {
      localStorage.setItem(key, value);
      return Promise.resolve();
    }
    localStorage.removeItem(key);
    return new Promise((resolve) =>
      tg.CloudStorage.setItem(key, value, (err) => {
        if (err) localStorage.setItem(key, value); // запасной вариант, если облако недоступно
        resolve();
      }),
    );
  },
  remove(key) {
    localStorage.removeItem(key);
    if (!useCloud) return Promise.resolve();
    return new Promise((resolve) => tg.CloudStorage.removeItem(key, () => resolve()));
  },
};

export function openExternal(url) {
  if (inTelegram) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

// Кнопка «Назад» Telegram: стек обработчиков (просмотрщик поверх настроек и т.п.)
const backStack = [];
function syncBack() {
  if (!inTelegram) return;
  if (backStack.length) tg.BackButton.show();
  else tg.BackButton.hide();
}
if (inTelegram) tg.BackButton.onClick(() => backStack[backStack.length - 1]?.());

export function pushBack(handler) {
  backStack.push(handler);
  syncBack();
  return () => {
    const i = backStack.lastIndexOf(handler);
    if (i >= 0) backStack.splice(i, 1);
    syncBack();
  };
}

export function haptic(type = 'light') {
  if (!can('6.1')) return;
  try {
    if (type === 'select') tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.impactOccurred(type);
  } catch {}
}

// Скачать файл средствами Telegram (Bot API 8.0+): Telegram сам загружает файл по ссылке
// и предлагает сохранить его — без перехода в браузер. Возвращает false, если не поддерживается.
export function downloadViaTelegram(url, fileName) {
  if (!can('8.0') || !tg.downloadFile) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      tg.downloadFile({ url, file_name: fileName }, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}
