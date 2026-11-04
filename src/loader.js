// Очередь загрузки превью: ограничение параллельности, отмена ушедших с экрана,
// приоритет последних запрошенных (то, что пользователь видит сейчас), кэш на диске и в памяти.
import { isAbort } from './api.js';
// disk — источник фото: сервер бота (api.js) или демо (mock-disk.js).

export class PreviewLoader {
  constructor(disk, store, { concurrency = 8, persist = true, memLimit = 700 } = {}) {
    this.disk = disk;
    this.store = store;
    this.concurrency = concurrency;
    this.persist = persist;
    this.memLimit = memLimit;
    this.urls = new Map(); // key -> objectURL (порядок вставки = LRU)
    this.jobs = new Map(); // key -> job
    this.queue = [];
    this.active = 0;
    this.dims = new Map(); // path -> [w, h] натуральный размер последнего загруженного превью
  }

  // S и M (как и L и XL) в Telegram — один и тот же файл: не качаем и не храним его дважды.
  key(item, size) {
    return (this.disk.sizeKey?.(size) || size) + '|' + item.p;
  }

  peek(item, size) {
    const k = this.key(item, size);
    const url = this.urls.get(k);
    if (url) {
      this.urls.delete(k);
      this.urls.set(k, url);
    }
    return url || null;
  }

  peekAny(item, sizes) {
    for (const s of sizes) {
      const u = this.peek(item, s);
      if (u) return u;
    }
    return null;
  }

  load(item, size) {
    const have = this.peek(item, size);
    if (have) return { promise: Promise.resolve(have), cancel() {} };
    const k = this.key(item, size);
    let job = this.jobs.get(k);
    if (!job) job = this._createJob(k, item, size);
    else if (!job.started) {
      // Снова нужен — поднимаем в начало очереди.
      this.queue.splice(this.queue.indexOf(job), 1);
      this.queue.push(job);
    }
    job.refs++;
    let cancelled = false;
    return {
      promise: job.promise,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        job.refs--;
        if (job.refs <= 0 && !job.done) this._abort(job);
      },
    };
  }

  _createJob(k, item, size) {
    const job = { k, item, size, refs: 0, started: false, done: false, controller: new AbortController() };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise.catch(() => {});
    this.jobs.set(k, job);
    this.queue.push(job);
    queueMicrotask(() => this._pump());
    return job;
  }

  _abort(job) {
    job.done = true;
    job.controller.abort();
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.jobs.get(job.k) === job) this.jobs.delete(job.k);
    job.reject(new DOMException('aborted', 'AbortError'));
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.pop();
      job.started = true;
      this.active++;
      this._run(job).finally(() => {
        this.active--;
        this._pump();
      });
    }
  }

  async _run(job) {
    try {
      const sk = this.disk.sizeKey?.(job.size) || job.size;
      let blob = this.persist ? await this.store.get(sk, job.item.p) : null;
      if (!blob) {
        if (job.controller.signal.aborted) return;
        blob = await this.disk.previewBlob(job.item, job.size, job.controller.signal);
        if (this.persist) this.store.put(sk, job.item.p, blob);
      }
      if (job.done) return;
      const url = URL.createObjectURL(blob);
      this._remember(job.k, url);
      job.done = true;
      if (this.jobs.get(job.k) === job) this.jobs.delete(job.k);
      job.resolve(url);
    } catch (e) {
      if (job.done) return;
      job.done = true;
      if (this.jobs.get(job.k) === job) this.jobs.delete(job.k);
      if (!isAbort(e)) console.warn('preview failed', job.item.p, e);
      job.reject(e);
    }
  }

  _remember(k, url) {
    this.urls.set(k, url);
    while (this.urls.size > this.memLimit) {
      const [oldK, oldUrl] = this.urls.entries().next().value;
      this.urls.delete(oldK);
      // Отложенно: картинка, которая уже на экране, успеет декодироваться.
      setTimeout(() => URL.revokeObjectURL(oldUrl), 5000);
    }
  }

  noteDims(item, img) {
    if (img.naturalWidth) this.dims.set(item.p, [img.naturalWidth, img.naturalHeight]);
  }

  clearMemory() {
    for (const job of [...this.jobs.values()]) this._abort(job);
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
