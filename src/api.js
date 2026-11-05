// Связь с нашим сервером (Cloudflare Worker). Токена бота здесь нет и быть не должно:
// приложение подтверждает, кто оно, строкой initData, которую подписал сам Telegram.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `Ошибка ${status}`);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const isAbort = (e) => e?.name === 'AbortError';

// Размеры превью, как их называет галерея, → какие есть в Telegram (~320, ~800 и до 2560 px).
const SIZE = { S: 'thumb', M: 'thumb', L: 'medium', XL: 'medium', XXL: 'large', XXXL: 'large' };
export const sizeKey = (size) => SIZE[size] || size;

// Альбомы — по тому, откуда пришло фото (в Telegram нет папок).
const ALBUM = { app: 'Загружено', auto: 'Автозагрузка', archive: 'Архив с iPhone', channel: 'Канал' };

// Запись с сервера → фото в том виде, в каком его понимает галерея:
// p — уникальный «путь» (по нему кэш, избранное, люди), n — имя, t — дата, la/lo — место.
export function normalize(it) {
  const n = it.n || `IMG_${it.i}.jpg`;
  return { ...it, n, p: `disk:/${ALBUM[it.o] || 'Из чата'}/${it.i}_${n}` };
}

export class Api {
  constructor(base, initData, user) {
    this.kind = 'real';
    this.user = user || {};
    this.base = base.replace(/\/+$/, '');
    this.initData = initData;
    this.fileToken = null;
    this.refreshing = null;
  }

  async req(path, { method = 'GET', body } = {}) {
    let r;
    try {
      r = await fetch(this.base + path, { method, body, headers: { authorization: 'tma ' + this.initData }, referrerPolicy: 'no-referrer' });
    } catch {
      throw new ApiError(0, 'network', 'Нет связи с сервером');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error, data.message, data);
    return data;
  }

  // Новые фото с номером больше after (или все, если after = 0). Заодно обновляем токен для файлов.
  async list(after = 0, onProgress) {
    const items = [];
    let cursor = after;
    for (;;) {
      const data = await this.req(`/api/list?after=${cursor}`);
      this.fileToken = data.fileToken;
      items.push(...data.items);
      onProgress?.(items.length);
      if (!data.next) return items;
      cursor = data.next;
    }
  }

  // ── То, что ждёт от «диска» код галереи ──
  sizeKey(size) {
    return sizeKey(size);
  }
  async me() {
    const u = this.user;
    return { uid: String(u.id || ''), name: [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : '') };
  }
  async listAll(onProgress) {
    return (await this.list(0, onProgress)).map(normalize);
  }
  // Только новые: с номером больше самого свежего из уже известных.
  async recent(known = []) {
    const last = known.reduce((m, it) => Math.max(m, it.i || 0), 0);
    return (await this.list(last)).map(normalize);
  }
  async originalUrl(item) {
    if (!this.fileToken) await this.refreshToken();
    return this.fileUrl(item, 'orig', { download: true });
  }

  // Токен для файлов живёт сутки; если истёк — тихо берём новый.
  refreshToken() {
    return (this.refreshing ||= this.req('/api/list?after=9007199254740991')
      .then((d) => (this.fileToken = d.fileToken))
      .finally(() => (this.refreshing = null)));
  }

  fileUrl(item, size, { download = false } = {}) {
    // v=1 — у оригинала уже есть лёгкая копия: другой адрес, чтобы браузер не взял из своего кэша
    // оригинал, скачанный по этому же адресу раньше.
    const v = item.k === 'd' && (item.v || item.vp) && size !== 'orig' ? '&v=1' : '';
    return `${this.base}/api/file/${item.i}?s=${sizeKey(size)}${v}&k=${encodeURIComponent(this.fileToken || '')}${download ? '&dl=1' : ''}`;
  }

  async previewBlob(item, size, signal) {
    if (!this.fileToken) await this.refreshToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(this.fileUrl(item, size), { signal, referrerPolicy: 'no-referrer' });
      if (r.ok) return r.blob();
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 && attempt === 0) {
        await this.refreshToken();
        continue;
      }
      if (r.status === 429 && attempt < 2) {
        await sleep((data.retry_after || 2) * 1000, signal);
        continue;
      }
      throw new ApiError(r.status, data.error, data.message);
    }
  }

  // Загрузка с прогрессом (у fetch его нет, поэтому XMLHttpRequest).
  upload(form, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', this.base + '/api/upload');
      x.setRequestHeader('authorization', 'tma ' + this.initData);
      x.responseType = 'json';
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
      x.onload = () => {
        const data = x.response || {};
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new ApiError(x.status, data.error, data.message, data));
      };
      x.onerror = () => reject(new ApiError(0, 'network', 'Нет связи с сервером'));
      x.onabort = () => reject(new DOMException('aborted', 'AbortError'));
      signal?.addEventListener('abort', () => x.abort());
      x.send(form);
    });
  }

  // Удалить фото. Ответ: chat = 'deleted' (и из чата) или 'kept' (сообщение старое — удалите в чате сами).
  deletePhoto(item) {
    return this.req(`/api/photo/${item.i}`, { method: 'DELETE' });
  }

  // Лёгкая копия оригинала (JPEG до 2560 px), чтобы он дальше открывался так же быстро, как обычное фото.
  async savePreview(item, blob, w, h) {
    const form = new FormData();
    form.set('file', blob, 'preview.jpg');
    if (w && h) {
      form.set('w', String(w));
      form.set('h', String(h));
    }
    const res = await this.req(`/api/photo/${item.i}/preview`, { method: 'POST', body: form });
    return res.item;
  }

  // Ключ автозагрузки для «Быстрых команд».
  autoKeyInfo() {
    return this.req('/api/auto/key');
  }
  createAutoKey() {
    return this.req('/api/auto/key', { method: 'POST' });
  }
  deleteAutoKey() {
    return this.req('/api/auto/key', { method: 'DELETE' });
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}
