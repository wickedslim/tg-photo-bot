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

export class Api {
  constructor(base, initData) {
    this.kind = 'real';
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

  // Токен для файлов живёт сутки; если истёк — тихо берём новый.
  refreshToken() {
    return (this.refreshing ||= this.req('/api/list?after=9007199254740991')
      .then((d) => (this.fileToken = d.fileToken))
      .finally(() => (this.refreshing = null)));
  }

  fileUrl(item, size, { download = false } = {}) {
    return `${this.base}/api/file/${item.i}?s=${size}&k=${encodeURIComponent(this.fileToken || '')}${download ? '&dl=1' : ''}`;
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
