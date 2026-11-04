import './style.css';
import { initTelegram, inTelegram, tg } from './tg.js';
import { Api, isAbort } from './api.js';
import { API_URL } from './config.js';
import { loadIndex, saveIndex, previewStore } from './store.js';
import { PreviewLoader } from './loader.js';
import { Library } from './library.js';
import { openViewer } from './viewer.js';
import { showSettings, showAutoUpload, showMessage, toast } from './screens.js';
import { showUploadSheet, Uploader } from './upload.js';

const FULL_REFRESH_MS = 24 * 3600 * 1000;
const app = document.getElementById('app');

initTelegram();
boot();

async function boot() {
  // Демо без Telegram и сервера (только в режиме разработки): http://localhost:5173/?mock
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const { MockApi } = await import('./mock.js');
    return start(new MockApi(), 'mock');
  }
  if (!inTelegram) {
    return showMessage(app, { title: 'Фото в Telegram', text: 'Это приложение открывается внутри Telegram: откройте чат с ботом и нажмите «Открыть галерею».' });
  }
  if (!API_URL) return showMessage(app, { title: 'Не настроено', text: 'Не указан адрес сервера (VITE_API_URL). См. README.' });
  const uid = tg.initDataUnsafe?.user?.id;
  start(new Api(API_URL, tg.initData), 'u' + uid);
}

async function start(api, ns) {
  const store = previewStore('previews-' + ns);
  const thumbs = new PreviewLoader(api, store, { concurrency: 8, persist: true, memLimit: 800 });
  const bigs = new PreviewLoader(api, store, { concurrency: 3, persist: false, memLimit: 16 });
  let all = [];
  let refreshing = null;

  const library = new Library(app, {
    loader: thumbs,
    onOpen: (items, index, host) => openViewer({ items, index, thumbs, bigs, api, host, toast }),
    onUpload: () => showUploadSheet({ onFiles: (files, mode) => uploader.add(files, mode) }),
    onSettings: () =>
      showSettings({
        count: all.length,
        onAuto: () => showAutoUpload({ api }),
        onRefresh: () => refresh(true),
        onClearCache: async () => {
          thumbs.clearMemory();
          await store.clear();
          library.setItems(all);
        },
      }),
  });

  // В элементах списка поле p — строковый ключ фото (по нему работают сетка и кэш миниатюр).
  const norm = (it) => ((it.p = String(it.i)), it);
  const setAll = (items) => {
    items.sort((a, b) => a.t - b.t || a.i - b.i);
    all = items;
    library.setItems(all);
  };
  const persist = (updated) => api.kind === 'mock' || saveIndex(ns, { items: all, updated });

  const uploader = new Uploader({
    api,
    toast,
    onState: (s) => library.setUpload(s),
    onItems: (items) => {
      const known = new Set(all.map((it) => it.i));
      const fresh = items.map(norm).filter((it) => !known.has(it.i));
      if (!fresh.length) return;
      setAll(all.concat(fresh));
      loadIndex(ns).then((prev) => persist(prev?.updated || Date.now()));
    },
  });

  async function refresh(full) {
    if (refreshing) return refreshing;
    library.setBusy(true, 'Загружаю список фото…');
    refreshing = (async () => {
      try {
        if (full) {
          const items = (await api.list(0, (n) => library.setBusy(true, `Загружаю список фото… ${n.toLocaleString('ru')}`))).map(norm);
          setAll(items);
          await persist(Date.now());
        } else {
          // Быстрое обновление: только фото, которые появились после последнего известного.
          const last = all.reduce((m, it) => Math.max(m, it.i), 0);
          const fresh = (await api.list(last)).map(norm);
          if (fresh.length) {
            const known = new Set(all.map((it) => it.i));
            setAll(all.concat(fresh.filter((it) => !known.has(it.i))));
            const prev = (await loadIndex(ns)) || {};
            await persist(prev.updated || Date.now());
          }
        }
      } catch (e) {
        if (!isAbort(e)) toast(e.message || 'Ошибка сети');
      } finally {
        library.setBusy(false);
        if (!all.length) library.setItems([]);
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // Вернулись в приложение (например, прислали фото в чат) — подтягиваем новые.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh(false));
  if (inTelegram) tg.onEvent('activated', () => refresh(false));

  const cached = api.kind === 'mock' ? null : await loadIndex(ns);
  if (cached?.items?.length) {
    setAll(cached.items);
    refresh(Date.now() - (cached.updated || 0) > FULL_REFRESH_MS);
  } else {
    refresh(true);
  }
}
