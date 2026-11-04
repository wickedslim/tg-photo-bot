// Локальный кэш на телефоне: список фото — в IndexedDB, миниатюры — в Cache Storage браузера.
// У каждого пользователя Telegram своё пространство имён (ns), чтобы фото разных аккаунтов не смешивались.
import { get, set, del } from 'idb-keyval';

const indexKey = (ns) => `index-v1:${ns}`;

export const loadIndex = (ns) => get(indexKey(ns));
export const saveIndex = (ns, data) => set(indexKey(ns), data);
export const clearIndex = (ns) => del(indexKey(ns));

export function previewStore(name) {
  let opened = null;
  const open = () => {
    if (!('caches' in window)) return Promise.resolve(null);
    return (opened ||= caches.open(name).catch(() => null));
  };
  const key = (size, id) => location.origin + '/__preview/' + size + '/' + encodeURIComponent(id);

  return {
    async get(size, id) {
      const c = await open();
      const r = c && (await c.match(key(size, id)));
      return r ? r.blob() : null;
    },
    async put(size, id, blob) {
      const c = await open();
      if (!c) return;
      const res = new Response(blob, { headers: { 'content-type': blob.type || 'image/jpeg' } });
      await c.put(key(size, id), res).catch(() => {});
    },
    async clear() {
      opened = null;
      if ('caches' in window) await caches.delete(name);
    },
  };
}

export async function storageUsage() {
  try {
    const e = await navigator.storage.estimate();
    return e.usage || 0;
  } catch {
    return 0;
  }
}
