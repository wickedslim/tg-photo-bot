// Проверка подлинности запросов.
//
// 1. initData — строка, которую Telegram передаёт мини-приложению при запуске. Она подписана ключом,
//    который выводится из токена бота, поэтому подделать её (и, значит, выдать себя за другого
//    пользователя) без токена нельзя. Номер пользователя берём ТОЛЬКО из проверенной initData.
//    https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// 2. Токен для файлов — короткая подпись «пользователь + срок действия». Картинки грузятся простыми
//    GET-запросами без заголовков (иначе браузер на каждую миниатюру делал бы лишний запрос-проверку
//    CORS и съедал бы бесплатную квоту вдвое быстрее), поэтому подпись передаётся в адресе.

const enc = new TextEncoder();

async function hmacKey(raw) {
  return crypto.subtle.importKey('raw', typeof raw === 'string' ? enc.encode(raw) : raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Сравнение без утечки по времени: не останавливаемся на первом несовпавшем символе.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Ключи зависят только от токена бота — считаем их один раз на экземпляр воркера.
const keyCache = new Map();
async function keysFor(botToken) {
  let k = keyCache.get(botToken);
  if (!k) {
    const webAppSecret = await hmac(await hmacKey('WebAppData'), botToken);
    const fileSecret = await hmac(await hmacKey('FileToken'), botToken);
    k = { initData: await hmacKey(webAppSecret), file: await hmacKey(fileSecret) };
    keyCache.clear();
    keyCache.set(botToken, k);
  }
  return k;
}

export class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const checkString = (params, skip) =>
  [...params.entries()]
    .filter(([k]) => !skip.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

/**
 * Проверяет initData и возвращает { user, authDate }.
 * maxAge — сколько секунд initData считается свежей (защита от повторного использования старой строки).
 */
export async function verifyInitData(initData, botToken, { maxAge = 86400, now = Date.now() } = {}) {
  if (!initData || typeof initData !== 'string' || initData.length > 8192) throw new AuthError('no_init_data');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new AuthError('bad_hash');
  const keys = await keysFor(botToken);
  // По документации подписаны все поля, кроме hash. Поле signature (для проверки без токена) появилось
  // позже; на случай, если клиент его не учитывал при подписи, пробуем и без него — оба варианта
  // всё равно требуют знания токена бота.
  let ok = safeEqual(toHex(await hmac(keys.initData, checkString(params, ['hash']))), hash);
  if (!ok && params.has('signature')) ok = safeEqual(toHex(await hmac(keys.initData, checkString(params, ['hash', 'signature']))), hash);
  if (!ok) throw new AuthError('bad_hash');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) throw new AuthError('bad_auth_date');
  const age = now / 1000 - authDate;
  if (age > maxAge) throw new AuthError('expired', 'Данные запуска устарели — перезапустите приложение');
  if (age < -300) throw new AuthError('bad_auth_date');

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    throw new AuthError('bad_user');
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new AuthError('bad_user');
  return { user, authDate };
}

// Достаёт initData из заголовка «Authorization: tma <initData>».
export function initDataFromRequest(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('tma ') ? h.slice(4) : '';
}

// ── Токен для файлов: "<uid>.<exp>.<подпись>" ──
export async function makeFileToken(uid, botToken, { ttl = 86400, now = Date.now() } = {}) {
  const exp = Math.floor(now / 1000) + ttl;
  const body = `${uid}.${exp}`;
  return { token: `${body}.${toB64url(await hmac((await keysFor(botToken)).file, body))}`, exp };
}

export async function verifyFileToken(token, botToken, { now = Date.now() } = {}) {
  const m = /^(\d{1,20})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  if (!m) throw new AuthError('bad_token');
  const [, uid, exp, sig] = m;
  const expected = toB64url(await hmac((await keysFor(botToken)).file, `${uid}.${exp}`));
  if (!safeEqual(expected, sig)) throw new AuthError('bad_token');
  if (Number(exp) < now / 1000) throw new AuthError('expired');
  return Number(uid);
}

// Для тестов и для скрипта разработки: подписать initData так же, как это делает Telegram.
export async function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const hash = toHex(await hmac((await keysFor(botToken)).initData, checkString(params, ['hash'])));
  params.set('hash', hash);
  return params.toString();
}
