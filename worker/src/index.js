// Сервер мини-приложения на Cloudflare Workers.
//
//   POST /tg/webhook      — сюда Telegram присылает новые сообщения боту (фото запоминаются в базе)
//   GET  /api/list        — список фото того, кто спрашивает
//   POST /api/upload      — загрузить фото из приложения в чат пользователя с ботом
//   GET  /api/file/:id    — скачать фото (только владельцу); токен бота наружу не попадает
//   GET/POST/DELETE /api/auto/key — личный ключ автозагрузки (создать, узнать, отключить)
//   GET  /api/auto/since  — с какой даты съёмки «Быстрой команде» искать новые фото
//
// Кто спрашивает, узнаём только из initData, подписанной Telegram (см. auth.js).
// Исключение — автозагрузка с iPhone: «Быстрые команды» не умеют входить через Telegram, поэтому
// у них личный ключ. Ключ даёт право ТОЛЬКО загружать фото в свой чат — смотреть фото по нему нельзя.

import { verifyInitData, initDataFromRequest, makeFileToken, verifyFileToken, AuthError, safeEqual } from './auth.js';
import { callApi, filePath, forgetPath, downloadFile, extractPhoto, TgError, MAX_DOWNLOAD, MAX_UPLOAD, MAX_PHOTO_UPLOAD } from './telegram.js';
import { readExif } from './exif.js';
import { savePhotos, listPhotos, getPhoto, toItem, hasHash, keyInfo, setKey, deleteKey, userByKey, touchKey } from './db.js';

const MAX_BATCH = 10; // столько фото Telegram принимает в один альбом
const MAX_BODY = 95 * 1024 * 1024; // Cloudflare на бесплатном тарифе принимает запросы до 100 МБ
const MAX_THUMB = 200 * 1024; // обложка документа: JPEG до 200 КБ и 320 px
const SIZES = new Set(['thumb', 'medium', 'large', 'orig']);

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json(request, env, { error: e.code, message: e.message, ...e.extra }, e.status);
      if (e instanceof AuthError) {
        const expired = e.code === 'expired';
        const message = expired ? 'Сессия устарела — закройте и снова откройте приложение' : 'Не удалось подтвердить, что запрос пришёл из Telegram — откройте приложение через бота';
        return json(request, env, { error: expired ? 'expired' : 'auth', message }, 401);
      }
      console.error(e);
      return json(request, env, { error: 'server', message: 'Ошибка сервера' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  if (!env.BOT_TOKEN) throw new HttpError(500, 'not_configured', 'Не задан BOT_TOKEN');

  if (request.method === 'OPTIONS') return preflight(request, env);
  if (pathname === '/tg/webhook' && request.method === 'POST') return webhook(request, env);
  if (pathname === '/api/list' && request.method === 'GET') return list(request, env, url);
  if (pathname === '/api/upload' && request.method === 'POST') return upload(request, env);
  if (pathname === '/api/auto/key') return autoKey(request, env, url);
  if (pathname === '/api/auto/since' && request.method === 'GET') return autoSince(request, env);
  const m = /^\/api\/file\/(\d{1,15})$/.exec(pathname);
  if (m && (request.method === 'GET' || request.method === 'HEAD')) return file(request, env, url, Number(m[1]));
  if (pathname === '/') return new Response('tg-photo-bot: ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  throw new HttpError(404, 'not_found', 'Нет такого адреса');
}

// ── Общие помощники ──
function cors(request, env) {
  const origin = request.headers.get('origin');
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const h = { vary: 'Origin' };
  if (origin && allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}

function json(request, env, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors(request, env), ...extra },
  });
}

function preflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors(request, env),
      'access-control-allow-methods': 'GET, POST, DELETE',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '86400',
    },
  });
}

function allowedUser(env, uid) {
  const list = String(env.ALLOWED_USERS || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return !list.length || list.includes(String(uid));
}

// Проверка initData + список разрешённых пользователей. Возвращает номер пользователя.
async function authUser(request, env) {
  const { user } = await verifyInitData(initDataFromRequest(request), env.BOT_TOKEN, { maxAge: Number(env.INIT_DATA_MAX_AGE) || 86400 });
  if (!allowedUser(env, user.id)) throw new HttpError(403, 'forbidden', 'Этот бот закрыт владельцем для посторонних');
  return user.id;
}

// ── Вебхук Telegram ──
async function webhook(request, env) {
  // Telegram присылает секрет, заданный при setWebhook: так мы отличаем его от посторонних запросов.
  const secret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!env.WEBHOOK_SECRET || !safeEqual(secret, env.WEBHOOK_SECRET)) return new Response('forbidden', { status: 403 });
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('ok');
  }
  const msg = update.message || update.edited_message;
  // Только личные сообщения от людей: группы и каналы бота не интересуют.
  if (!msg || msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot || msg.chat.id !== msg.from.id) return new Response('ok');
  const uid = msg.from.id;
  const text = (msg.text || '').trim();

  if (!allowedUser(env, uid)) {
    if (text.startsWith('/start')) return reply(uid, 'Это личный бот — его владелец не открыл доступ для других.');
    return new Response('ok');
  }
  if (/^\/(start|help)(@\w+)?(\s|$)/.test(text)) {
    return reply(
      uid,
      'Это ваша фотогалерея в Telegram.\n\n' +
        '• Присылайте сюда фото — они сразу появятся в галерее. Чтобы сохранить без сжатия, отправляйте их файлом.\n' +
        '• Или загружайте прямо из галереи кнопкой «Загрузить».\n\n' +
        'Фото хранятся в этом чате. Удалите сообщение здесь — и фото пропадёт из Telegram.',
      env.WEBAPP_URL ? { inline_keyboard: [[{ text: 'Открыть галерею', web_app: { url: env.WEBAPP_URL } }]] } : undefined,
    );
  }
  const rec = extractPhoto(msg);
  if (rec) {
    if (rec.kind === 'doc') Object.assign(rec, await docMeta(env, rec));
    await savePhotos(env.DB, uid, [rec]);
  }
  return new Response('ok');
}

// Картинку, присланную файлом, Telegram не трогает — в ней сохранились дата съёмки и место.
// Читаем только начало файла (там EXIF), чтобы не качать его целиком.
async function docMeta(env, rec) {
  if (!rec.size || rec.size > MAX_DOWNLOAD) return {};
  try {
    const path = await filePath(env.BOT_TOKEN, rec.orig_id);
    const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`, { headers: { range: 'bytes=0-262143' } });
    if (!r.ok) return {};
    const buf = new Uint8Array(await r.arrayBuffer()).subarray(0, 262144);
    const ex = readExif(buf);
    const out = place(ex);
    if (ex.taken && ex.taken > Date.UTC(1990, 0, 1) && ex.taken < Date.now() + 86400000) out.taken = ex.taken;
    return out;
  } catch {
    return {};
  }
}

// Ответ прямо в теле ответа на вебхук — Telegram выполнит его сам, лишний запрос не нужен.
function reply(chatId, text, replyMarkup) {
  const body = { method: 'sendMessage', chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

// ── Список фото ──
async function list(request, env, url) {
  const uid = await authUser(request, env);
  const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
  const limit = 2000;
  const rows = await listPhotos(env.DB, uid, { after, limit });
  const { token, exp } = await makeFileToken(uid, env.BOT_TOKEN);
  return json(request, env, {
    items: rows.map(toItem),
    next: rows.length === limit ? rows[rows.length - 1].id : null,
    fileToken: token,
    fileTokenExp: exp,
  });
}

// ── Загрузка ──
const cleanName = (n, fallback) =>
  String(n || fallback)
    .replace(/[\\/\u0000-\u001f"]/g, '_')
    .slice(-120) || fallback;

const IMAGE_NAME = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?|dng)$/i;

function place(m) {
  const la = Number(m?.la);
  const lo = Number(m?.lo);
  if (m?.la == null || m?.lo == null || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (!la && !lo)) return {};
  return { lat: +la.toFixed(6), lon: +lo.toFixed(6) };
}

function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

// Кто загружает: приложение (initData) или «Быстрая команда» (личный ключ).
async function uploader(request, env) {
  const h = request.headers.get('authorization') || '';
  if (!h.startsWith('Key ')) return { uid: await authUser(request, env), source: 'app' };
  const row = await keyOwner(request, env);
  return { uid: row.user_id, source: 'auto' };
}

async function upload(request, env) {
  const { uid, source } = await uploader(request, env);
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'too_big', 'Слишком большой запрос — загружайте меньше фото за раз');
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'bad_request', 'Не удалось прочитать файлы');
  }
  const asDoc = form.get('mode') === 'doc';
  let meta = [];
  try {
    meta = JSON.parse(form.get('meta') || '[]');
  } catch {}
  if (!Array.isArray(meta)) meta = [];
  // Простой вариант для «Быстрых команд»: одно фото в полях file, thumb и taken (дата съёмки текстом).
  if (form.get('taken') && !meta[0]) meta[0] = { taken: Date.parse(form.get('taken')) };
  if (form.get('la') && form.get('lo')) Object.assign((meta[0] ||= {}), { la: Number(form.get('la')), lo: Number(form.get('lo')) });

  const files = [];
  const seen = new Set();
  let skipped = 0;
  for (let i = 0; i < MAX_BATCH + 1; i++) {
    const f = form.get('f' + i) ?? (i === 0 ? form.get('file') : null);
    if (f == null) break;
    if (i === MAX_BATCH) throw new HttpError(400, 'bad_request', `Не больше ${MAX_BATCH} фото за раз`);
    if (typeof f === 'string' || !f.size) throw new HttpError(400, 'bad_request', 'Пустой файл');
    const name = cleanName(f.name, `photo_${i + 1}.jpg`);
    const isImage = (f.type || '').startsWith('image/') || IMAGE_NAME.test(name);
    if (!isImage) throw new HttpError(400, 'not_image', `«${name}» — не фото`);
    const limit = asDoc ? MAX_UPLOAD : MAX_PHOTO_UPLOAD;
    if (f.size > limit) throw new HttpError(413, 'too_big', `«${name}» больше ${limit / 1024 / 1024} МБ`);
    let thumb = asDoc ? (form.get('t' + i) ?? (i === 0 ? form.get('thumb') : null)) : null;
    if (thumb && (typeof thumb === 'string' || !thumb.size || thumb.size > MAX_THUMB)) thumb = null;
    // Одно и то же фото дважды не загружаем: автозагрузка может прислать его повторно.
    const buf = await f.arrayBuffer();
    const hash = await sha256(buf);
    if (seen.has(hash) || (await hasHash(env.DB, uid, hash))) {
      skipped++;
      continue;
    }
    seen.add(hash);
    // Дата и место: что прислало приложение, иначе — из EXIF самого файла (если он его сохранил).
    const m = { ...(meta[i] || {}) };
    if (m.taken == null || m.la == null) {
      const ex = readExif(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512 * 1024)));
      m.taken ??= ex.taken;
      if (m.la == null && ex.la != null) Object.assign(m, { la: ex.la, lo: ex.lo });
    }
    files.push({ f, name, thumb, hash, meta: m });
  }
  if (!files.length && !skipped) throw new HttpError(400, 'bad_request', 'Нет файлов');
  const now = Date.now();
  const takenOf = (m) => num(m.taken, Date.UTC(1990, 0, 1), now + 86400000);
  if (!files.length) {
    if (source === 'auto') await touchKey(env.DB, uid, now, Math.max(0, ...meta.map((m) => takenOf(m || {}) || 0)));
    return json(request, env, { ok: true, items: [], skipped });
  }

  // Сообщение отправляется ТОЛЬКО в личный чат того, кто загружает: chat_id берём из проверенной
  // initData (или из ключа, который выдан этому пользователю), а не из запроса.
  const fd = new FormData();
  fd.set('chat_id', String(uid));
  fd.set('disable_notification', 'true');
  let method;
  if (files.length === 1) {
    const { f, name, thumb } = files[0];
    method = asDoc ? 'sendDocument' : 'sendPhoto';
    fd.set(asDoc ? 'document' : 'photo', f, name);
    if (thumb) fd.set('thumbnail', thumb, 'thumb.jpg');
  } else {
    method = 'sendMediaGroup';
    const media = files.map(({ thumb }, i) => {
      const m = { type: asDoc ? 'document' : 'photo', media: `attach://f${i}` };
      if (thumb) m.thumbnail = `attach://t${i}`;
      return m;
    });
    fd.set('media', JSON.stringify(media));
    files.forEach(({ f, name, thumb }, i) => {
      fd.set('f' + i, f, name);
      if (thumb) fd.set('t' + i, thumb, `t${i}.jpg`);
    });
  }

  let result;
  try {
    result = await callApi(env.BOT_TOKEN, method, fd);
  } catch (e) {
    if (!(e instanceof TgError)) throw e;
    if (e.status === 429) throw new HttpError(429, 'rate', 'Telegram просит подождать', { retry_after: e.retryAfter || 5 });
    if (e.status === 403) throw new HttpError(409, 'start_bot', 'Откройте чат с ботом и нажмите «Старт», потом попробуйте снова');
    throw new HttpError(502, 'tg', `Telegram не принял фото: ${e.message}`);
  }
  const messages = Array.isArray(result) ? result : [result];
  const recs = [];
  messages.forEach((msg, i) => {
    const rec = extractPhoto(msg);
    const src = files[i];
    if (!rec || !src) return;
    // Дата съёмки — из EXIF, которую прочитало приложение (Telegram её у фото стирает).
    rec.taken = takenOf(src.meta);
    Object.assign(rec, place(src.meta));
    rec.hash = src.hash;
    rec.source = source;
    if (rec.kind === 'doc') {
      rec.width = num(src.meta.w, 1, 100000);
      rec.height = num(src.meta.h, 1, 100000);
    }
    recs.push(rec);
  });
  const rows = await savePhotos(env.DB, uid, recs);
  if (source === 'auto') await touchKey(env.DB, uid, now, Math.max(0, ...recs.map((r) => r.taken || 0)));
  return json(request, env, { ok: true, items: rows.map(toItem), skipped });
}

async function sha256(data) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Автозагрузка: личный ключ ──
const KEY_RE = /^tgp_[A-Za-z0-9_-]{32}$/;

async function keyOwner(request, env) {
  const h = request.headers.get('authorization') || '';
  const key = h.startsWith('Key ') ? h.slice(4).trim() : '';
  if (!KEY_RE.test(key)) throw new HttpError(401, 'bad_key', 'Нет ключа автозагрузки или он записан с ошибкой');
  const row = await userByKey(env.DB, await sha256(key));
  if (!row) throw new HttpError(401, 'bad_key', 'Ключ не подходит — создайте новый в приложении (Настройки → Автозагрузка)');
  if (!allowedUser(env, row.user_id)) throw new HttpError(403, 'forbidden', 'Этот бот закрыт владельцем для посторонних');
  return row;
}

async function autoKey(request, env, url) {
  const uid = await authUser(request, env);
  const base = url.origin;
  if (request.method === 'GET') {
    const info = await keyInfo(env.DB, uid);
    return json(request, env, { exists: Boolean(info), created: info?.created || null, cursor: info?.cursor || null, used: info?.used || null, base });
  }
  if (request.method === 'POST') {
    // Новый ключ заменяет старый: старый сразу перестаёт работать. Сам ключ показываем один раз.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = 'tgp_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
    await setKey(env.DB, uid, await sha256(key), Date.now());
    return json(request, env, { key, base, uploadUrl: `${base}/api/upload`, sinceUrl: `${base}/api/auto/since` });
  }
  if (request.method === 'DELETE') {
    await deleteKey(env.DB, uid);
    return json(request, env, { ok: true });
  }
  throw new HttpError(405, 'bad_request', 'Не тот метод');
}

// С какой даты съёмки искать новые фото. Ответ — просто дата текстом (ISO 8601), так её проще
// всего превратить в дату в «Быстрых командах». Берём на секунду раньше последнего загруженного:
// у серийной съёмки бывает несколько кадров в одну секунду, а повторы всё равно отсеются по хэшу.
async function autoSince(request, env) {
  const row = await keyOwner(request, env);
  const ms = row.cursor ? row.cursor - 1000 : row.created;
  return new Response(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── Скачивание фото ──
async function file(request, env, url, id) {
  const uid = await verifyFileToken(url.searchParams.get('k'), env.BOT_TOKEN);
  if (!allowedUser(env, uid)) throw new HttpError(403, 'forbidden', 'Нет доступа');
  const size = url.searchParams.get('s') || 'thumb';
  if (!SIZES.has(size)) throw new HttpError(400, 'bad_request', 'Неизвестный размер');
  // Ищем фото сразу с условием «владелец = тот, кто спрашивает». Чужое фото выглядит как несуществующее.
  const row = await getPhoto(env.DB, uid, id);
  if (!row) throw new HttpError(404, 'not_found', 'Фото не найдено');

  let fileId = row[`${size}_id`];
  let isOrig = row.kind === 'doc' && fileId === row.orig_id;
  if (isOrig && row.size > MAX_DOWNLOAD) {
    // Telegram не отдаёт ботам файлы больше 20 МБ. Для просмотра хватит обложки, если она есть.
    if (size === 'orig' || row.thumb_id === row.orig_id) throw new HttpError(413, 'too_big', 'Файл больше 20 МБ — его можно открыть только в чате с ботом');
    fileId = row.thumb_id;
    isOrig = false;
  }

  let upstream;
  for (let attempt = 0; attempt < 2; attempt++) {
    let path;
    try {
      path = await filePath(env.BOT_TOKEN, fileId);
    } catch (e) {
      if (e instanceof TgError && e.status === 429) throw new HttpError(429, 'rate', 'Telegram просит подождать', { retry_after: e.retryAfter || 3 });
      if (e instanceof TgError) throw new HttpError(502, 'tg', 'Telegram не отдал файл');
      throw e;
    }
    upstream = await downloadFile(env.BOT_TOKEN, path);
    if (upstream.ok) break;
    forgetPath(fileId);
  }
  if (!upstream.ok) throw new HttpError(502, 'tg', 'Telegram не отдал файл');

  let type = 'image/jpeg';
  if (isOrig) type = row.mime && row.mime.startsWith('image/') ? row.mime : 'application/octet-stream';
  const headers = {
    ...cors(request, env),
    'content-type': type,
    // Содержимое по этому адресу никогда не меняется — пусть телефон хранит его сколько угодно.
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
  };
  const lenHeader = upstream.headers.get('content-length');
  if (lenHeader) headers['content-length'] = lenHeader;
  if (url.searchParams.get('dl') === '1') {
    const name = row.name || `photo_${row.id}.jpg`;
    headers['content-disposition'] = `attachment; filename="photo_${row.id}${(name.match(/\.[A-Za-z0-9]{1,5}$/) || ['.jpg'])[0]}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { headers });
}

