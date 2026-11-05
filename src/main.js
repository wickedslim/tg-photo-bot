import './style.css';
import { initTelegram, inTelegram, tg, haptic } from './tg.js';
import { Api, normalize, isAbort } from './api.js';
import { API_URL } from './config.js';
import { loadIndex, saveIndex, previewStore, wipeLocalData } from './store.js';
import { PreviewLoader } from './loader.js';
import { Library } from './library.js';
import { Collections, openPage } from './collections.js';
import { Search } from './search.js';
import { Favorites } from './favorites.js';
import { openViewer } from './viewer.js';
import { showSettings, showAutoUpload, showMessage, toast, askText } from './screens.js';
import { showUploadSheet, Uploader } from './upload.js';
import { Indexer } from './ml/indexer.js';
import { Backfill } from './previews.js';

const FULL_REFRESH_MS = 24 * 3600 * 1000;
// Меняется, когда список фото с сервера получает новые поля: сохранённый на телефоне список
// старой версии один раз загружается заново целиком. 2 — флаг лёгкой копии у оригиналов (v).
const INDEX_VER = 2;
const app = document.getElementById('app');

initTelegram();
boot();

async function boot() {
  // Демо без Telegram и сервера (только в режиме разработки): http://localhost:5173/?mock
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const { MockDisk } = await import('./mock-disk.js');
    return startLibrary(new MockDisk(), 'mock');
  }
  if (!inTelegram) {
    return showMessage(app, { title: 'Фото в Telegram', text: 'Это приложение открывается внутри Telegram: откройте чат с ботом и нажмите «Открыть галерею».' });
  }
  if (!API_URL) return showMessage(app, { title: 'Не настроено', text: 'Не указан адрес сервера (VITE_API_URL). См. README.' });
  const user = tg.initDataUnsafe?.user || {};
  // У каждого пользователя Telegram на этом устройстве — свои кэш, избранное и люди.
  startLibrary(new Api(API_URL, tg.initData, user), 'u' + user.id);
}

async function startLibrary(disk, ns) {
  const store = previewStore('previews-' + ns);
  const thumbs = new PreviewLoader(disk, store, { concurrency: 8, persist: true, memLimit: 800 });
  const bigs = new PreviewLoader(disk, store, { concurrency: 3, persist: false, memLimit: 16 });

  let all = [];
  let refreshing = null;
  const favorites = new Favorites(ns);
  favorites.load();

  const apply = () => {
    library.setItems(all);
    indexer.setItems(all);
    collections.setItems(all);
    search.setItems(all);
    backfill.setItems(all);
  };

  // Каркас: три вкладки и таб-бар внизу, как в «Фото» на iPhone.
  app.innerHTML = `
    <div class="tab" data-tab="library"></div>
    <div class="tab" data-tab="collections"></div>
    <div class="tab" data-tab="search"></div>
    <nav class="tabbar">
      <button data-tab="library"><svg viewBox="0 0 28 28" width="26" height="26"><rect x="3" y="7" width="18" height="16" rx="3.5" fill="currentColor"/><path d="M7.5 4.5h14A3.5 3.5 0 0 1 25 8v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Медиатека</span></button>
      <button data-tab="collections"><svg viewBox="0 0 28 28" width="26" height="26"><rect x="3" y="3" width="10" height="10" rx="2.5" fill="currentColor"/><rect x="15" y="3" width="10" height="10" rx="2.5" fill="currentColor" opacity=".55"/><rect x="3" y="15" width="10" height="10" rx="2.5" fill="currentColor" opacity=".55"/><rect x="15" y="15" width="10" height="10" rx="2.5" fill="currentColor"/></svg><span>Коллекции</span></button>
      <button data-tab="search"><svg viewBox="0 0 28 28" width="26" height="26"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="m17.6 17.6 6 6" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg><span>Поиск</span></button>
    </nav>`;
  const tabEl = (name) => app.querySelector(`.tab[data-tab="${name}"]`);
  const showTab = (name) => {
    app.querySelectorAll('[data-tab]').forEach((e) => e.classList.toggle('active', e.dataset.tab === name));
  };
  app.querySelector('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    showTab(b.dataset.tab);
    haptic('light');
  });
  showTab('library');

  const indexer = new Indexer({ ns, disk, store });
  // Лёгкие копии для оригиналов (фото файлом) — в фоне, чтобы они открывались быстро с первого раза.
  const backfill = new Backfill({ disk, onDone: () => saveUpdated() });
  if (import.meta.env.DEV) Object.assign(window, { __ix: indexer, __disk: disk }); // для отладки в браузере
  const askName = (current) =>
    askText({ title: current ? 'Изменить имя' : 'Кто это?', message: 'Если дать двум карточкам одно имя, они объединятся.', value: current, placeholder: 'Имя' });
  const openV = (items, index, host) => openViewer({ items, index, thumbs, bigs, disk, host, favorites, toast, onDelete: removeItem, onUpdate: saveUpdated });

  // У фото появилась лёгкая копия (или размеры) — запоминаем список, чтобы это пережило перезапуск.
  async function saveUpdated() {
    const prev = (await loadIndex(ns)) || {};
    await persist(prev.updated || Date.now());
  }

  // Что стало с сообщением в Telegram (ответ сервера): 'deleted' — удалено, 'replaced' — старое, бот заменил
  // снимок заглушкой «Фото удалено», 'kept' — фото прислал сам человек больше 48 часов назад, боту его не тронуть.
  function deletedText(chat) {
    if (chat === 'replaced') return 'Фото удалено. В чате на его месте осталась заглушка — её можно стереть вручную';
    if (chat === 'kept') return 'Удалено из галереи. Это фото вы присылали боту сами больше 48 часов назад — удалите его в чате вручную';
    return 'Фото удалено';
  }
  // Удаление: сервер убирает фото из базы и (если Telegram разрешит) из чата, мы — из ленты и избранного.
  async function removeItem(it) {
    const res = await disk.deletePhoto(it);
    if (favorites.has(it.p)) favorites.toggle(it.p);
    all = all.filter((x) => x.p !== it.p);
    apply();
    const prev = (await loadIndex(ns)) || {};
    await persist(prev.updated || Date.now());
    haptic('medium');
    toast(deletedText(res?.chat));
  }
  // Удалить сразу несколько фото (лишние копии из «Дубликатов»): по одному, потом один раз обновляем ленту.
  // onProgress(n) — сколько уже удалено (для надписи «Удаляю… 5 из 40»). Возвращает пути удалённых фото.
  async function removeMany(list, onProgress) {
    const gone = new Set();
    let kept = 0;
    try {
      for (const it of list) {
        const res = await disk.deletePhoto(it);
        gone.add(it.p);
        if (res?.chat === 'kept') kept++;
        if (favorites.has(it.p)) favorites.toggle(it.p);
        onProgress?.(gone.size);
      }
    } catch (e) {
      toast(e?.message || 'Не удалось удалить');
    }
    if (!gone.size) return gone;
    all = all.filter((x) => !gone.has(x.p));
    apply();
    const prev = (await loadIndex(ns)) || {};
    await persist(prev.updated || Date.now());
    haptic('medium');
    toast(kept ? `Удалено: ${gone.size}. Не получилось убрать из Telegram ${kept} — это фото, которые вы присылали боту сами больше 48 часов назад: удалите их в чате вручную` : `Удалено: ${gone.size}`);
    return gone;
  }

  const collections = new Collections(tabEl('collections'), {
    loader: thumbs,
    favorites,
    indexer,
    askName,
    openPage: (opts) => openPage(tabEl('collections'), { ...opts, loader: thumbs, onOpen: openV, onDeleteMany: removeMany }),
    onDeleteMany: removeMany,
  });
  const search = new Search(tabEl('search'), { loader: thumbs, onOpen: openV, indexer });

  const library = new Library(tabEl('library'), {
    loader: thumbs,
    onOpen: openV,
    onDeleteMany: removeMany,
    onUpload: () => showUploadSheet({ onFiles: (files, mode) => uploader.add(files, mode) }),
    onSettings: () =>
      showSettings({
        disk,
        count: all.length,
        indexer,
        onAuto: () => showAutoUpload({ api: disk }),
        onReindex: () => refresh(true),
        onClearCache: async () => {
          thumbs.clearMemory();
          await store.clear();
          library.setItems(all);
        },
        onWipe: async () => {
          // На устройстве не остаётся ничего: список фото, миниатюры, лица, имена, избранное.
          // Сами фото остаются в чате с ботом — при следующем открытии список загрузится заново.
          thumbs.clearMemory();
          bigs.clearMemory();
          await indexer.disable();
          await wipeLocalData(ns);
          await favorites.clear();
          location.reload();
        },
      }),
  });

  const persist = (updated) => disk.kind === 'mock' || saveIndex(ns, { items: all, updated, ver: INDEX_VER });
  const setAll = (items) => {
    items.sort((a, b) => a.t - b.t || a.i - b.i);
    all = items;
    apply();
  };
  const addItems = async (fresh) => {
    const known = new Set(all.map((it) => it.p));
    fresh = fresh.filter((it) => !known.has(it.p));
    if (!fresh.length) return;
    setAll(all.concat(fresh));
    const prev = (await loadIndex(ns)) || {};
    await persist(prev.updated || Date.now());
  };

  const uploader = new Uploader({
    api: disk,
    toast,
    onState: (s) => library.setUpload(s),
    onItems: (items) => addItems(items.map(normalize)),
  });

  async function refresh(full) {
    if (refreshing) return refreshing;
    library.setBusy(true, 'Загружаю список фото…');
    refreshing = (async () => {
      try {
        if (full) {
          const items = await disk.listAll((n) => library.setBusy(true, `Загружаю список фото… ${n.toLocaleString('ru')}`));
          setAll(items);
          await persist(Date.now());
        } else {
          // Быстрое обновление: только фото, которые появились после самого свежего известного.
          await addItems(await disk.recent(all));
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

  // Вернулись в приложение (например, прислали фото боту в чат) — подтягиваем новые.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh(false));
  if (inTelegram) tg.onEvent('activated', () => refresh(false));

  const cached = disk.kind === 'mock' ? null : await loadIndex(ns);
  if (cached?.items?.length) {
    setAll(cached.items);
    refresh(cached.ver !== INDEX_VER || Date.now() - (cached.updated || 0) > FULL_REFRESH_MS);
  } else {
    refresh(true);
  }
}
