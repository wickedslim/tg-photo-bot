// Сервер мини-приложения на Cloudflare Workers.
//
//   POST /tg/webhook      — сюда Telegram присылает новые сообщения боту (фото запоминаются в базе)
//   GET  /api/list        — список фото того, кто спрашивает
//   POST /api/upload      — загрузить фото из приложения в чат пользователя с ботом
//   GET  /api/file/:id    — скачать фото (только владельцу); токен бота наружу не попадает
//   DELETE /api/photo/:id — удалить фото из галереи и из чата (старое — заменить в чате заглушкой)
//   POST /api/photo/:id/preview — лёгкая копия оригинала для быстрого просмотра (делает приложение)
//   GET/POST/DELETE /api/auto/key — личный ключ автозагрузки (создать, узнать, отключить)
//   GET  /api/auto/since  — с какой даты съёмки «Быстрой команде» искать новые фото
//   GET  /api/auto/archive — то же для команды «Архив» (старые фото, от самых старых к новым)
//   GET  /api/auto/next   — одна готовая команда: что загружать сейчас (с какой даты, куда, как, сколько)
//   POST /api/auto/settings — настройки автозагрузки из галереи (оригиналы, старые фото)
//
// Кто спрашивает, узнаём только из initData, подписанной Telegram (см. auth.js).
// Исключение — автозагрузка с iPhone: «Быстрые команды» не умеют входить через Telegram, поэтому
// у них личный ключ. Ключ даёт право ТОЛЬКО загружать фото в свой чат — смотреть фото по нему нельзя.

import { verifyInitData, initDataFromRequest, makeFileToken, verifyFileToken, AuthError, safeEqual } from './auth.js';
import { callApi, filePath, forgetPath, downloadFile, extractPhoto, TgError, MAX_DOWNLOAD, MAX_UPLOAD, MAX_PHOTO_UPLOAD } from './telegram.js';
import { readExif, isScreenshot } from './exif.js';
import { stubJpeg, STUB_CAPTION } from './stub.js';
import { savePhotos, listPhotos, getPhoto, toItem, hasHash, keyInfo, setKey, deleteKey, userByKey, touchKey, archiveInfo, touchArchive, hasTakenAt, setPreview, channelOwner, linkChannel, unlinkChannel, findDuplicate, autoSettings, saveAutoSettings, touchNew } from './db.js';

const MAX_BATCH = 10; // столько фото Telegram принимает в один альбом
const MAX_BODY = 95 * 1024 * 1024; // Cloudflare на бесплатном тарифе принимает запросы до 100 МБ
const MAX_THUMB = 200 * 1024; // обложка документа: JPEG до 200 КБ и 320 px
const MAX_PREVIEW = 5 * 1024 * 1024; // лёгкая копия оригинала: JPEG до 2560 px
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
  if (pathname === '/tg/webhook' && request.method === 'POST') {
    ctx?.waitUntil?.(ensureWebhook(env, url.origin));
    return webhook(request, env);
  }
  if (pathname === '/api/list' && request.method === 'GET') {
    ctx?.waitUntil?.(ensureWebhook(env, url.origin));
    return list(request, env, url);
  }
  if (pathname === '/api/upload' && request.method === 'POST') return upload(request, env, url);
  if (pathname === '/api/auto/key') return autoKey(request, env, url);
  if (pathname === '/api/auto/since' && request.method === 'GET') return autoSince(request, env);
  if (pathname === '/api/auto/archive' && request.method === 'GET') return archiveSince(request, env);
  if (pathname === '/api/auto/next' && request.method === 'GET') return autoNext(request, env, url);
  if (pathname === '/api/auto/settings' && request.method === 'POST') return autoSettingsRoute(request, env);
  const pv = /^\/api\/photo\/(\d{1,15})\/preview$/.exec(pathname);
  if (pv && request.method === 'POST') return previewRoute(request, env, Number(pv[1]));
  const del = /^\/api\/photo\/(\d{1,15})$/.exec(pathname);
  if (del && request.method === 'DELETE') return removePhoto(request, env, Number(del[1]));
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
  if (update.my_chat_member) return memberUpdate(env, update.my_chat_member);
  const post = update.channel_post || update.edited_channel_post;
  if (post) return channelPost(env, post);
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
        'Фото хранятся в этом чате. Удалить фото можно корзиной в галерее.\n\n' +
        'Как пользоваться и как настроить автозагрузку с iPhone: https://github.com/wickedslim/tg-photo-bot/blob/main/docs/user-guide.md',
      env.WEBAPP_URL ? { inline_keyboard: [[{ text: 'Открыть галерею', web_app: { url: env.WEBAPP_URL } }]] } : undefined,
    );
  }
  const rec = extractPhoto(msg);
  if (rec) await saveIncoming(env, uid, rec);
  return new Response('ok');
}

// Фото, присланное боту или опубликованное в канале. Если такое уже есть в галерее, второй раз не
// добавляем (сообщение в чате остаётся — его можно удалить самому).
async function saveIncoming(env, uid, rec) {
  if (rec.caption === STUB_CAPTION) return; // заглушка вместо удалённого фото — не фото
  if (await findDuplicate(env.DB, uid, rec)) return;
  if (rec.kind === 'doc') Object.assign(rec, await docMeta(env, rec));
  await savePhotos(env.DB, uid, [rec]);
}

// ── Канал владельца ──
// Бота сделали администратором канала: всё, что публикуется в этом канале, — фото того, кто его добавил.
// Удалять сообщения бот может только первые 48 часов (и в чате, и в канале); старые фото корзина заменяет
// заглушкой — в канале для этого нужно право «Редактировать сообщения».
async function memberUpdate(env, m) {
  const chat = m.chat || {};
  if (chat.type !== 'channel' || !m.from || m.from.is_bot) return new Response('ok');
  const st = m.new_chat_member || {};
  if (st.status === 'administrator') {
    if (!allowedUser(env, m.from.id)) return new Response('ok');
    await linkChannel(env.DB, m.from.id, chat.id, chat.title || null, st.can_delete_messages, Date.now());
    const title = chat.title ? `«${chat.title}»` : '';
    return reply(
      m.from.id,
      `Канал ${title} подключён. Всё, что вы опубликуете в нём, появится в галерее.` +
        (st.can_delete_messages && st.can_edit_messages
          ? ''
          : '\n\nДайте боту в канале права «Удалять сообщения» и «Редактировать сообщения» — иначе корзина в галерее не сможет убирать фото из канала.'),
    );
  }
  if (['left', 'kicked', 'member', 'restricted'].includes(st.status)) {
    const was = await unlinkChannel(env.DB, chat.id);
    if (was) return reply(was.user_id, `Бот больше не администратор канала${was.title ? ` «${was.title}»` : ''}: новые фото оттуда в галерею не попадут. Уже загруженные останутся.`);
  }
  return new Response('ok');
}

async function channelPost(env, post) {
  const owner = await channelOwner(env.DB, post.chat?.id);
  if (!owner || !allowedUser(env, owner.user_id)) return new Response('ok');
  const rec = extractPhoto(post);
  if (rec) {
    rec.source = 'channel';
    await saveIncoming(env, owner.user_id, rec);
  }
  return new Response('ok');
}

// Какие события Telegram присылает боту. Если вебхук настроен по-старому (без каналов), сервер
// сам дописывает нужное — так не нужно заново вводить токен бота. Проверяем раз на запуск сервера.
const UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'];
let webhookChecked = false;
async function ensureWebhook(env, origin) {
  if (webhookChecked || !env.WEBHOOK_SECRET) return;
  webhookChecked = true;
  try {
    const info = await callApi(env.BOT_TOKEN, 'getWebhookInfo', {});
    const url = `${origin}/tg/webhook`;
    if (info.url !== url) return; // вебхук смотрит не на этот сервер — не трогаем
    const have = info.allowed_updates || [];
    if (!have.length || UPDATES.every((u) => have.includes(u))) return;
    await callApi(env.BOT_TOKEN, 'setWebhook', { url, secret_token: env.WEBHOOK_SECRET, allowed_updates: UPDATES });
  } catch {
    webhookChecked = false;
  }
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
  return { uid: row.user_id, source: 'auto', key: row };
}

async function upload(request, env, url) {
  const who = await uploader(request, env);
  const { uid } = who;
  const archive = url.searchParams.get('archive') === '1';
  if (archive && who.source !== 'auto') throw new HttpError(400, 'bad_request', 'Архив загружается только командой «Архив» с ключом');
  const source = archive ? 'archive' : who.source;
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'too_big', 'Слишком большой запрос — загружайте меньше фото за раз');
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'bad_request', 'Не удалось прочитать файлы');
  }
  let asDoc = form.get('mode') === 'doc';
  let meta = [];
  try {
    meta = JSON.parse(form.get('meta') || '[]');
  } catch {}
  if (!Array.isArray(meta)) meta = [];
  // Простой вариант для «Быстрых команд»: одно фото в полях file, thumb и taken (дата съёмки текстом).
  if (form.get('taken') && !meta[0]) meta[0] = { taken: Date.parse(form.get('taken')) };
  if (form.get('la') && form.get('lo')) Object.assign((meta[0] ||= {}), { la: Number(form.get('la')), lo: Number(form.get('lo')) });
  const now = Date.now();

  // Архив идёт от старых фото к новым и останавливается на фото, снятых после создания ключа, —
  // дальше их везёт обычная автозагрузка. Докуда дошли, запоминаем даже для пропущенных фото,
  // иначе команда будет снова и снова находить одни и те же.
  let archiveAt = null;
  if (archive) {
    archiveAt = Date.parse(form.get('taken') || '');
    if (!Number.isFinite(archiveAt)) throw new HttpError(400, 'no_date', 'Нет даты съёмки — проверьте в команде поле taken');
    if (archiveAt >= who.key.created) {
      await touchArchive(env.DB, uid, now, who.key.created);
      return json(request, env, { ok: true, items: [], skipped: 1, done: true });
    }
    const prev = await archiveInfo(env.DB, uid);
    // Уже есть фото, снятое в ту же секунду: загружено кнопкой или автозагрузкой — или это последнее
    // фото прошлого запуска (команда начинает на секунду раньше, чтобы не пропустить соседние кадры).
    if (await hasTakenAt(env.DB, uid, archiveAt, prev?.cursor != null && archiveAt <= prev.cursor)) {
      await touchArchive(env.DB, uid, now, archiveAt);
      return json(request, env, { ok: true, items: [], skipped: 1 });
    }
  }

  // Фото, которое Telegram не примет как сжатое (HEIC с iPhone, больше 10 МБ и т. п.), отправляем файлом —
  // так «Быстрая команда» без шага «Конвертировать» тоже работает. Приложение такие фото готовит само.
  if (!asDoc) {
    for (let i = 0; i < MAX_BATCH; i++) {
      const f = form.get('f' + i) ?? (i === 0 ? form.get('file') : null);
      if (!f || typeof f === 'string') break;
      const okType = /^image\/(jpeg|png|webp)$/.test(f.type) || (!f.type && /\.(jpe?g|png|webp)$/i.test(f.name || ''));
      if (!okType || f.size > MAX_PHOTO_UPLOAD) asDoc = true;
    }
  }

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
    const preview = asDoc ? validPreview(form.get('v' + i) ?? (i === 0 ? form.get('preview') : null)) : null;
    // Одно и то же фото дважды не загружаем: автозагрузка может прислать его повторно.
    const buf = await f.arrayBuffer();
    const hash = await sha256(buf);
    if (seen.has(hash) || (await hasHash(env.DB, uid, hash))) {
      skipped++;
      continue;
    }
    seen.add(hash);
    const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16 * 1024 * 1024));
    // Скриншоты автозагрузка не берёт. Фильтр «Не снимок экрана» в «Командах» на iOS 26 не работает,
    // поэтому отсеиваем их здесь — по метке «Screenshot», которую iPhone пишет в метаданные.
    const shot = who.source === 'auto' && isScreenshot(bytes);
    if (who.source === 'auto') console.log(JSON.stringify({ auto: 1, shot, head: [...bytes.subarray(0, 4)].map((b) => b.toString(16)).join(''), size: buf.byteLength }));
    if (shot) {
      skipped++;
      continue;
    }
    // Дата и место: что прислало приложение, иначе — из EXIF самого файла (если он его сохранил).
    const m = { ...(meta[i] || {}) };
    if (m.taken == null || m.la == null) {
      const ex = readExif(bytes);
      m.taken ??= ex.taken;
      if (m.la == null && ex.la != null) Object.assign(m, { la: ex.la, lo: ex.lo });
    }
    files.push({ f, name, thumb, preview, hash, meta: m });
  }
  if (!files.length && !skipped) throw new HttpError(400, 'bad_request', 'Нет файлов');
  const takenOf = (m) => num(m.taken, Date.UTC(1990, 0, 1), now + 86400000);
  if (!files.length) {
    if (archive) await touchArchive(env.DB, uid, now, archiveAt);
    else if (source === 'auto') await touchKey(env.DB, uid, now, Math.max(0, ...meta.map((m) => takenOf(m || {}) || 0)));
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
  const previews = [];
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
    previews.push(src.preview);
  });
  const rows = await savePhotos(env.DB, uid, recs);
  // Оригиналы с лёгкой копией от приложения: сразу прикрепляем копию, чтобы фото быстро открывалось.
  // Telegram попросил подождать — не страшно: копию сделает просмотр, когда фото откроют.
  for (let k = 0; k < rows.length; k++) {
    if (!previews[k] || rows[k].kind !== 'doc') continue;
    try {
      rows[k] = (await attachPreview(env, uid, rows[k].id, previews[k], files[k]?.meta)) || rows[k];
    } catch (e) {
      if (e instanceof TgError) break;
      throw e;
    }
  }
  if (archive) await touchArchive(env.DB, uid, now, archiveAt);
  else if (source === 'auto') await touchKey(env.DB, uid, now, Math.max(0, ...recs.map((r) => r.taken || 0)));
  return json(request, env, { ok: true, items: rows.map(toItem), skipped });
}

function validPreview(v) {
  if (!v || typeof v === 'string' || !v.size || v.size > MAX_PREVIEW) return null;
  return v.type && v.type !== 'image/jpeg' ? null : v;
}

// Лёгкая копия оригинала. Telegram хранит у сжатого фото готовые размеры (320, 800 … 2560 px) —
// отправляем копию как фото, запоминаем эти размеры и сразу удаляем сообщение, чтобы в чате не было дублей.
// Если когда-нибудь копия станет недоступна, просмотр вернётся к оригиналу (см. file()).
async function attachPreview(env, uid, id, blob, meta = {}) {
  const fd = new FormData();
  fd.set('chat_id', String(uid));
  fd.set('disable_notification', 'true');
  fd.set('photo', blob, 'preview.jpg');
  const msg = await callApi(env.BOT_TOKEN, 'sendPhoto', fd, { waitUpTo: 3 });
  const rec = extractPhoto(msg);
  if (!rec || rec.kind !== 'photo') return null;
  const row = await setPreview(env.DB, uid, id, {
    thumb_id: rec.thumb_id,
    medium_id: rec.medium_id,
    large_id: rec.large_id,
    width: num(meta.w, 1, 100000) ?? rec.width,
    height: num(meta.h, 1, 100000) ?? rec.height,
  });
  try {
    await callApi(env.BOT_TOKEN, 'deleteMessage', { chat_id: uid, message_id: msg.message_id }, { waitUpTo: 2 });
  } catch {}
  return row;
}

async function previewRoute(request, env, id) {
  const uid = await authUser(request, env);
  const row = await env.DB.prepare('SELECT kind, large_id, orig_id FROM photos WHERE id = ? AND user_id = ?').bind(id, uid).first();
  if (!row) throw new HttpError(404, 'not_found', 'Фото не найдено');
  if (row.kind !== 'doc') throw new HttpError(400, 'bad_request', 'Копия нужна только оригиналам');
  // Уже есть — второй раз не отправляем (например, фото открыли на двух устройствах сразу).
  if (row.large_id !== row.orig_id) return json(request, env, { ok: true, item: null });
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'bad_request', 'Не удалось прочитать файл');
  }
  const blob = validPreview(form.get('file'));
  if (!blob) throw new HttpError(400, 'bad_request', 'Нужен JPEG до 5 МБ');
  let saved;
  try {
    saved = await attachPreview(env, uid, id, blob, { w: form.get('w'), h: form.get('h') });
  } catch (e) {
    if (!(e instanceof TgError)) throw e;
    if (e.status === 429) throw new HttpError(429, 'rate', 'Telegram просит подождать', { retry_after: e.retryAfter || 5 });
    throw new HttpError(502, 'tg', 'Telegram не принял копию');
  }
  return json(request, env, { ok: true, item: saved ? toItem(saved) : null });
}

async function sha256(data) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Удаление ──
// Из базы удаляем всегда. Из чата — как получится:
//   • сообщению меньше 48 часов — удаляем ('deleted');
//   • старше — удалить боту нельзя, но свои сообщения он может менять без срока: подменяем фото
//     заглушкой «Фото удалено» ('replaced'). Так получится со всем, что отправил бот: кнопка «Загрузить»,
//     автозагрузка, «Архив» (и с постами канала, если у бота есть право редактировать);
//   • фото, которое человек прислал боту сам, бот не может ни удалить, ни изменить — пусть удалит в чате ('kept').
async function removePhoto(request, env, id) {
  const uid = await authUser(request, env);
  const row = await env.DB.prepare('SELECT chat_id, message_id, kind FROM photos WHERE id = ? AND user_id = ?').bind(id, uid).first();
  if (!row) throw new HttpError(404, 'not_found', 'Фото не найдено');
  let chat = 'deleted';
  try {
    await callApi(env.BOT_TOKEN, 'deleteMessage', { chat_id: row.chat_id, message_id: row.message_id }, { waitUpTo: 3 });
  } catch (e) {
    if (!(e instanceof TgError)) throw e;
    // «message to delete not found» — в чате его уже нет, это тоже удачное удаление.
    if (!/not found/i.test(e.message)) chat = await replaceWithStub(env, row);
  }
  await env.DB.prepare('DELETE FROM photos WHERE id = ? AND user_id = ?').bind(id, uid).run();
  return json(request, env, { ok: true, chat });
}

// Загруженную заглушку Telegram запоминает: дальше её можно ставить по file_id, не отправляя заново.
const stubIds = {};

async function replaceWithStub(env, row) {
  // Тип — как у фото: в альбоме Telegram разрешает менять фото только на фото, файл — только на файл.
  const type = row.kind === 'doc' ? 'document' : 'photo';
  const edit = async (media, files) => {
    const fd = new FormData();
    fd.set('chat_id', String(row.chat_id));
    fd.set('message_id', String(row.message_id));
    fd.set('media', JSON.stringify({ type, media, caption: STUB_CAPTION, ...(files && type === 'document' ? { thumbnail: 'attach://t' } : {}) }));
    if (files) {
      fd.set('f', stubJpeg(), 'udaleno.jpg');
      if (type === 'document') fd.set('t', stubJpeg(), 't.jpg');
    }
    return callApi(env.BOT_TOKEN, 'editMessageMedia', fd, { waitUpTo: 3 });
  };
  try {
    let msg;
    if (stubIds[type]) {
      try {
        msg = await edit(stubIds[type]);
      } catch (e) {
        if (!(e instanceof TgError) || !/file|wrong/i.test(e.message)) throw e;
        delete stubIds[type]; // Telegram забыл файл — загрузим заглушку заново
      }
    }
    msg ||= await edit('attach://f', true);
    const id = type === 'document' ? msg?.document?.file_id : msg?.photo?.at?.(-1)?.file_id;
    if (id) stubIds[type] = id;
    return 'replaced';
  } catch (e) {
    if (!(e instanceof TgError)) return 'kept';
    if (/not modified/i.test(e.message)) return 'replaced'; // заглушка уже стоит
    if (/not found/i.test(e.message)) return 'deleted';
    return 'kept'; // «message can't be edited»: фото прислал сам человек
  }
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
    const a = await archiveInfo(env.DB, uid);
    const archive = a ? { cursor: a.cursor, used: a.used, count: a.count || 0, done: archiveDone(a, info) } : null;
    const { original, archive: withArchive } = await autoSettings(env.DB, uid);
    return json(request, env, { exists: Boolean(info), created: info?.created || null, cursor: info?.cursor || null, used: info?.used || null, base, archive, settings: { original, archive: withArchive } });
  }
  if (request.method === 'POST') {
    // Новый ключ заменяет старый: старый сразу перестаёт работать. Сам ключ показываем один раз.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = 'tgp_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
    await setKey(env.DB, uid, await sha256(key), Date.now());
    return json(request, env, { key, base, nextUrl: `${base}/api/auto/next`, uploadUrl: `${base}/api/upload`, sinceUrl: `${base}/api/auto/since`, archiveUploadUrl: `${base}/api/upload?archive=1`, archiveSinceUrl: `${base}/api/auto/archive` });
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

// «С какой даты» для команды «Архив». Пока ничего не загружено — с 1900 года, то есть со всех фото.
// Когда архив дошёл до фото, снятых после создания ключа, отвечаем датой из далёкого будущего:
// команда ничего не найдёт и сразу закончит.
async function archiveSince(request, env) {
  const row = await keyOwner(request, env);
  const p = await archiveInfo(env.DB, row.user_id);
  let ms = Date.UTC(1900, 0, 1);
  if (p?.cursor != null) ms = p.cursor >= row.created ? Date.UTC(2100, 0, 1) : p.cursor - 1000;
  return new Response(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const archiveDone = (a, key) => Boolean(key && a?.cursor != null && a.cursor >= key.created);
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const LIMIT = 100; // в готовой команде число фото за запуск записано само (100); здесь — для своих команд
const NEW_EVERY = 3 * 3600 * 1000;

// Задание для готовой команды «Фото в Telegram» (одна на всех, ссылкой iCloud). Команда спрашивает сервер,
// что делать, и всё, что можно менять, решается здесь, а не в самой команде:
//   since  — искать фото, снятые после этой даты (ISO 8601); ago — то же числом: сколько секунд назад;
//   limit  — сколько фото взять за запуск;
//   upload — куда их отправлять (обычная загрузка или архив);
//   mode   — 'photo' (сжать в JPEG до 2560 px на телефоне) или 'doc' (оригинал файлом + обложка).
// Старые фото (если включены в галерее) идут вперемешку с новыми: раз в 3 часа запуск везёт новые
// снимки, остальные запуски — следующую порцию архива. Когда архив дойдёт до конца, остаются только новые.
async function autoNext(request, env, url) {
  const row = await keyOwner(request, env);
  const uid = row.user_id;
  const now = Date.now();
  const s = await autoSettings(env.DB, uid);
  const base = url.origin;
  let stage = 'new';
  let since = row.cursor ? row.cursor - 1000 : row.created;
  // Новые фото проверялись меньше 3 часов назад — этот запуск отдаём архиву.
  if (s.archive && s.lastNew != null && now - s.lastNew < NEW_EVERY) {
    const a = await archiveInfo(env.DB, uid);
    if (!archiveDone(a, row)) {
      stage = 'archive';
      since = a?.cursor != null ? a.cursor - 1000 : Date.UTC(1900, 0, 1);
    }
  }
  if (stage === 'new') await touchNew(env.DB, uid, now);
  return json(request, env, {
    stage,
    since: isoSec(since),
    // То же «с какой даты», но числом: сколько секунд назад. «Команды» не всегда понимают дату текстом,
    // а «Текущая дата минус N секунд» (действие «Изменить дату») работает всегда. С запасом в 5 секунд
    // на дорогу ответа — повторы всё равно отсеются.
    ago: Math.max(0, Math.ceil((now - since) / 1000) + 5),
    limit: LIMIT,
    upload: `${base}/api/upload${stage === 'archive' ? '?archive=1' : ''}`,
    mode: s.original ? 'doc' : 'photo',
  });
}

async function autoSettingsRoute(request, env) {
  const uid = await authUser(request, env);
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'Не удалось прочитать настройки');
  }
  const cur = await autoSettings(env.DB, uid);
  const next = {
    original: typeof body?.original === 'boolean' ? body.original : cur.original,
    archive: typeof body?.archive === 'boolean' ? body.archive : cur.archive,
  };
  await saveAutoSettings(env.DB, uid, next);
  return json(request, env, { ok: true, settings: next });
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

  const fetchFile = async (id) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let path;
      try {
        path = await filePath(env.BOT_TOKEN, id);
      } catch (e) {
        if (e instanceof TgError && e.status === 429) throw new HttpError(429, 'rate', 'Telegram просит подождать', { retry_after: e.retryAfter || 3 });
        if (e instanceof TgError) return null;
        throw e;
      }
      const r = await downloadFile(env.BOT_TOKEN, path);
      if (r.ok) return r;
      forgetPath(id);
    }
    return null;
  };
  let upstream = await fetchFile(fileId);
  // Лёгкая копия оригинала пропала у Telegram — показываем сам оригинал (если он не больше 20 МБ).
  if (!upstream && row.kind === 'doc' && fileId !== row.orig_id && (!row.size || row.size <= MAX_DOWNLOAD)) {
    upstream = await fetchFile(row.orig_id);
    isOrig = true;
  }
  if (!upstream) throw new HttpError(502, 'tg', 'Telegram не отдал файл');

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

