// Работа с Bot API: вызовы методов, скачивание файлов и разбор сообщений с фото.

const API = 'https://api.telegram.org';

export const MAX_DOWNLOAD = 20 * 1024 * 1024; // getFile отдаёт файлы только до 20 МБ
export const MAX_UPLOAD = 50 * 1024 * 1024; // файл документом — до 50 МБ
export const MAX_PHOTO_UPLOAD = 10 * 1024 * 1024; // sendPhoto — до 10 МБ

export class TgError extends Error {
  constructor(status, description, retryAfter) {
    super(description || `Telegram ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// body — объект (уйдёт как JSON) или FormData (с файлами).
// При 429 «слишком часто» один раз ждём сами, если ждать недолго; иначе отдаём ошибку с retryAfter.
export async function callApi(token, method, body, { waitUpTo = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const init = { method: 'POST' };
    if (body instanceof FormData) init.body = body;
    else {
      init.body = JSON.stringify(body || {});
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await fetch(`${API}/bot${token}/${method}`, init);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new TgError(res.status, 'Telegram вернул непонятный ответ');
    }
    if (data.ok) return data.result;
    const retryAfter = data.parameters?.retry_after;
    if (data.error_code === 429 && retryAfter && retryAfter <= waitUpTo && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
      continue;
    }
    throw new TgError(data.error_code || res.status, data.description, retryAfter);
  }
}

// file_path, который возвращает getFile, живёт не меньше часа — помним его, чтобы не спрашивать
// Telegram на каждую миниатюру. Кэш живёт, пока жив экземпляр воркера.
const pathCache = new Map();
const PATH_TTL = 50 * 60 * 1000;

export async function filePath(token, fileId) {
  const hit = pathCache.get(fileId);
  if (hit && hit.exp > Date.now()) return hit.path;
  const f = await callApi(token, 'getFile', { file_id: fileId }, { waitUpTo: 2 });
  if (!f.file_path) throw new TgError(404, 'Файл недоступен');
  if (pathCache.size > 5000) pathCache.clear();
  pathCache.set(fileId, { path: f.file_path, exp: Date.now() + PATH_TTL });
  return f.file_path;
}

export function forgetPath(fileId) {
  pathCache.delete(fileId);
}

export function downloadFile(token, path) {
  return fetch(`${API}/file/bot${token}/${path}`);
}

// ── Разбор сообщения ──
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i;

export function isImageDocument(doc) {
  if (!doc) return false;
  if (doc.mime_type) return doc.mime_type.startsWith('image/');
  return IMAGE_EXT.test(doc.file_name || '');
}

const side = (p) => Math.max(p.width || 0, p.height || 0);
const short = (p) => ({ id: p.file_id, u: p.file_unique_id, w: p.width, h: p.height, s: p.file_size });

// Превращает сообщение с фото или картинкой-файлом в запись для базы. Иначе — null.
export function extractPhoto(msg) {
  if (!msg) return null;
  const base = {
    chat_id: msg.chat?.id,
    message_id: msg.message_id,
    date: msg.date,
    caption: msg.caption ? String(msg.caption).slice(0, 1024) : null,
    media_group_id: msg.media_group_id || null,
    source: 'chat',
  };
  if (Array.isArray(msg.photo) && msg.photo.length) {
    // Telegram присылает несколько копий разного размера (обычно 90, 320, 800, 1280 и 2560 px).
    const sizes = [...msg.photo].sort((a, b) => side(a) - side(b));
    const largest = sizes[sizes.length - 1];
    const atLeast = (px) => sizes.find((p) => side(p) >= px) || largest;
    return {
      ...base,
      kind: 'photo',
      width: largest.width,
      height: largest.height,
      size: largest.file_size || null,
      name: null,
      mime: 'image/jpeg',
      thumb_id: atLeast(300).file_id,
      medium_id: atLeast(700).file_id,
      large_id: largest.file_id,
      orig_id: largest.file_id,
      fuid: largest.file_unique_id || null,
      sizes: JSON.stringify(sizes.map(short)),
    };
  }
  const doc = msg.document;
  if (isImageDocument(doc)) {
    // Картинка, отправленная файлом: оригинал без сжатия и маленькая обложка (до 320 px).
    const thumb = doc.thumbnail || doc.thumb;
    const sizes = [];
    if (thumb) sizes.push(short(thumb));
    sizes.push({ id: doc.file_id, u: doc.file_unique_id, s: doc.file_size, orig: true });
    return {
      ...base,
      kind: 'doc',
      width: null,
      height: null,
      size: doc.file_size || null,
      name: doc.file_name ? String(doc.file_name).slice(0, 255) : null,
      mime: doc.mime_type || null,
      thumb_id: thumb ? thumb.file_id : doc.file_id,
      // Средний размер — обложка: сетке не нужен оригинал в несколько мегабайт. Когда появится
      // лёгкая копия для просмотра (см. setPreview), средний и большой размеры возьмутся из неё.
      medium_id: thumb ? thumb.file_id : doc.file_id,
      large_id: doc.file_id,
      orig_id: doc.file_id,
      fuid: doc.file_unique_id || null,
      sizes: JSON.stringify(sizes),
    };
  }
  return null;
}
