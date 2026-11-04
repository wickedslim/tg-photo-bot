// Сервер целиком: настоящий воркер в Miniflare (локальный Cloudflare) с настоящей базой D1.
// Вместо Telegram — подставной сервер, который запоминает, куда бот отправлял фото.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { signInitData } from '../worker/src/auth.js';

const TOKEN = '123456:TEST-token';
const SECRET = 'hook-secret';
const ORIGIN = 'https://example.github.io';
const A = 111;
const B = 222;

let mf;
const sent = []; // что бот отправлял в Telegram: { method, chat_id }
let msgId = 1000;

function fakeTelegram(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'api.telegram.org') return new Response('нет сети', { status: 502 });
  const fileM = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
  if (fileM) return new Response(`IMG:${fileM[1]}`, { headers: { 'content-type': 'application/octet-stream' } });
  const method = url.pathname.split('/').pop();
  return (async () => {
    const form = request.headers.get('content-type')?.includes('multipart') ? await request.formData() : null;
    const body = form ? Object.fromEntries([...form.keys()].map((k) => [k, form.get(k)])) : await request.json();
    const photo = (id) => [
      { file_id: `${id}_s`, file_unique_id: `${id}u_s`, width: 90, height: 60 },
      { file_id: `${id}_m`, file_unique_id: `${id}u_m`, width: 320, height: 213 },
      { file_id: `${id}_x`, file_unique_id: `${id}u_x`, width: 800, height: 533 },
      { file_id: `${id}_y`, file_unique_id: `${id}u_y`, width: 1280, height: 853, file_size: 200000 },
    ];
    const msg = (extra) => ({ message_id: ++msgId, date: 1700000000, chat: { id: Number(body.chat_id), type: 'private' }, ...extra });
    let result;
    if (method === 'getFile') result = { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg` };
    else if (method === 'sendPhoto') result = msg({ photo: photo('p' + msgId) });
    else if (method === 'sendDocument') result = msg({ document: { file_id: 'd' + msgId, file_unique_id: 'du' + msgId, file_name: 'IMG.HEIC', mime_type: 'image/heic', file_size: 3000000 } });
    else if (method === 'sendMediaGroup') result = JSON.parse(body.media).map(() => msg({ photo: photo('g' + msgId) }));
    else return Response.json({ ok: false, error_code: 400, description: 'unknown method' });
    sent.push({ method, chat_id: Number(body.chat_id) });
    return Response.json({ ok: true, result });
  })();
}

before(async () => {
  const out = await build({ entryPoints: ['worker/src/index.js'], bundle: true, format: 'esm', write: false, platform: 'neutral' });
  mf = new Miniflare({
    modules: true,
    script: out.outputFiles[0].text,
    compatibilityDate: '2026-04-20',
    d1Databases: ['DB'],
    bindings: { BOT_TOKEN: TOKEN, WEBHOOK_SECRET: SECRET, ALLOWED_ORIGIN: ORIGIN, WEBAPP_URL: 'https://example.github.io/app/' },
    outboundService: fakeTelegram,
  });
  const db = await mf.getD1Database('DB');
  const sql = readFileSync('worker/migrations/0001_init.sql', 'utf8').replace(/--.*$/gm, '');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
});

after(() => mf?.dispose());

const initData = (id, extra = {}) => signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id, first_name: 'T' }, ...extra }, TOKEN);
const api = async (path, { user, headers = {}, body, ...init } = {}) => {
  headers = { origin: ORIGIN, ...(user ? { authorization: 'tma ' + (await initData(user)) } : {}), ...headers };
  if (body instanceof FormData) {
    // Miniflare не принимает FormData напрямую — превращаем её в байты, как это сделал бы браузер.
    const req = new Request('http://x/', { method: 'POST', body });
    headers['content-type'] = req.headers.get('content-type');
    body = await req.arrayBuffer();
  }
  return mf.dispatchFetch('http://worker' + path, { ...init, body, headers });
};
const hook = (update, secret = SECRET) =>
  mf.dispatchFetch('http://worker/tg/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }, body: JSON.stringify(update) });
const listOf = async (user) => (await (await api('/api/list', { user })).json());
const photoMsg = (from, message_id, extra = {}) => ({
  update_id: message_id,
  message: { message_id, date: 1700000000 + message_id, from: { id: from, is_bot: false, first_name: 'T' }, chat: { id: from, type: 'private' }, photo: [{ file_id: `u${from}_${message_id}`, file_unique_id: 'x', width: 1280, height: 960 }], ...extra },
});
const jpeg = (text) => new File([text], 'IMG_1.jpg', { type: 'image/jpeg' });

test('вебхук без секрета или с чужим секретом отклоняется', async () => {
  assert.equal((await hook(photoMsg(A, 1), 'wrong')).status, 403);
  assert.equal((await mf.dispatchFetch('http://worker/tg/webhook', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await listOf(A)).items.length, 0);
});

test('/start отвечает кнопкой, открывающей галерею', async () => {
  const r = await hook({ update_id: 1, message: { message_id: 5, date: 1, text: '/start', from: { id: A, first_name: 'T' }, chat: { id: A, type: 'private' } } });
  const body = await r.json();
  assert.equal(body.method, 'sendMessage');
  assert.equal(body.chat_id, A);
  assert.equal(body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.github.io/app/');
});

test('фото, присланные боту, видит только их владелец', async () => {
  assert.equal((await hook(photoMsg(A, 10))).status, 200);
  await hook(photoMsg(A, 11, { caption: 'море' }));
  await hook(photoMsg(B, 12));
  // сообщения из групп не запоминаются
  await hook({ update_id: 99, message: { ...photoMsg(A, 13).message, chat: { id: -100, type: 'group' } } });
  const a = await listOf(A);
  const b = await listOf(B);
  assert.equal(a.items.length, 2);
  assert.equal(a.items[1].c, 'море');
  assert.equal(b.items.length, 1);
  assert.ok(!JSON.stringify(a).includes('u111_'), 'file_id наружу не отдаются');
});

test('список без входа или с поддельной initData — 401', async () => {
  assert.equal((await api('/api/list')).status, 401);
  const forged = await signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: A } }, '999:OTHER');
  assert.equal((await api('/api/list', { headers: { authorization: 'tma ' + forged } })).status, 401);
  const old = await signInitData({ auth_date: Math.floor(Date.now() / 1000) - 3 * 86400, user: { id: A } }, TOKEN);
  const r = await api('/api/list', { headers: { authorization: 'tma ' + old } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'expired');
});

test('файл скачивает только владелец', async () => {
  const a = await listOf(A);
  const b = await listOf(B);
  const id = a.items[0].i;
  const own = await api(`/api/file/${id}?s=large&k=${a.fileToken}`);
  assert.equal(own.status, 200);
  assert.equal(await own.text(), `IMG:photos/u${A}_10.jpg`);
  assert.match(own.headers.get('cache-control'), /immutable/);
  assert.equal(own.headers.get('access-control-allow-origin'), ORIGIN);
  // B со своим настоящим токеном просит фото A — для него этого фото нет
  assert.equal((await api(`/api/file/${id}?s=large&k=${b.fileToken}`)).status, 404);
  // поддельный токен
  const [, exp, sig] = b.fileToken.split('.');
  assert.equal((await api(`/api/file/${id}?k=${A}.${exp}.${sig}`)).status, 401);
  assert.equal((await api(`/api/file/${id}`)).status, 401);
});

test('загрузка уходит только в чат того, кто загружает', async () => {
  sent.length = 0;
  const form = new FormData();
  form.set('chat_id', String(B)); // попытка подсунуть чужой чат — должна игнорироваться
  form.set('meta', JSON.stringify([{ taken: Date.UTC(2024, 6, 1) }]));
  form.set('f0', jpeg('one'));
  const r = await api('/api/upload', { user: A, method: 'POST', body: form });
  assert.equal(r.status, 200, await r.clone().text());
  const body = await r.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].t, Date.UTC(2024, 6, 1));
  assert.deepEqual(sent, [{ method: 'sendPhoto', chat_id: A }]);
  assert.equal((await listOf(B)).items.length, 1);
});

test('альбомом и без повторов', async () => {
  sent.length = 0;
  const form = new FormData();
  ['a', 'b', 'c', 'a'].forEach((t, i) => form.set('f' + i, jpeg('album-' + t)));
  const body = await (await api('/api/upload', { user: A, method: 'POST', body: form })).json();
  assert.equal(body.items.length, 3);
  assert.equal(body.skipped, 1);
  assert.deepEqual(sent, [{ method: 'sendMediaGroup', chat_id: A }]);
  // то же фото ещё раз — в Telegram ничего не уходит
  sent.length = 0;
  const again = new FormData();
  again.set('f0', jpeg('album-b'));
  const r2 = await (await api('/api/upload', { user: A, method: 'POST', body: again })).json();
  assert.equal(r2.skipped, 1);
  assert.equal(sent.length, 0);
  // а у другого пользователя такое же фото — загружается (проверка повторов у каждого своя)
  const forB = new FormData();
  forB.set('f0', jpeg('album-b'));
  assert.equal((await (await api('/api/upload', { user: B, method: 'POST', body: forB })).json()).items.length, 1);
});

test('загрузка без входа — 401, не картинка — 400', async () => {
  const form = new FormData();
  form.set('f0', jpeg('x'));
  assert.equal((await api('/api/upload', { method: 'POST', body: form })).status, 401);
  const bad = new FormData();
  bad.set('f0', new File(['<html>'], 'page.html', { type: 'text/html' }));
  assert.equal((await api('/api/upload', { user: A, method: 'POST', body: bad })).status, 400);
});

test('ключ автозагрузки: загружает только в свой чат и ничего не показывает', async () => {
  // без ключа
  assert.equal((await api('/api/auto/key', { user: A })).status, 200);
  assert.equal((await (await api('/api/auto/key', { user: A })).json()).exists, false);
  const created = await (await api('/api/auto/key', { user: A, method: 'POST' })).json();
  assert.match(created.key, /^tgp_[A-Za-z0-9_-]{32}$/);
  const auth = { authorization: 'Key ' + created.key };

  // дата, с которой искать фото: пока ничего не загружено — момент создания ключа
  const since = await (await api('/api/auto/since', { headers: auth })).text();
  assert.match(since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

  sent.length = 0;
  const form = new FormData();
  form.set('mode', 'doc');
  form.set('file', new File(['heic-bytes'], 'IMG_9.HEIC', { type: 'image/heic' }));
  form.set('thumb', new File(['thumb'], 't.jpg', { type: 'image/jpeg' }));
  form.set('taken', '2026-11-04T20:15:00+03:00');
  const r = await api('/api/upload', { headers: auth, method: 'POST', body: form });
  assert.equal(r.status, 200);
  assert.deepEqual(sent, [{ method: 'sendDocument', chat_id: A }]);
  assert.equal((await r.json()).items[0].t, Date.parse('2026-11-04T17:15:00Z'));
  // теперь «с какой даты» — на секунду раньше последнего загруженного фото
  assert.equal(await (await api('/api/auto/since', { headers: auth })).text(), '2026-11-04T17:14:59Z');

  // ключом нельзя смотреть фото и управлять ключами
  assert.equal((await api('/api/list', { headers: auth })).status, 401);
  assert.equal((await api('/api/auto/key', { headers: auth, method: 'POST' })).status, 401);

  // новый ключ отменяет старый
  const next = await (await api('/api/auto/key', { user: A, method: 'POST' })).json();
  assert.notEqual(next.key, created.key);
  assert.equal((await api('/api/auto/since', { headers: auth })).status, 401);
  assert.equal((await api('/api/auto/since', { headers: { authorization: 'Key ' + next.key } })).status, 200);
  // отключение
  await api('/api/auto/key', { user: A, method: 'DELETE' });
  assert.equal((await api('/api/auto/since', { headers: { authorization: 'Key ' + next.key } })).status, 401);
  assert.equal((await api('/api/auto/since', { headers: { authorization: 'Key tgp_' + 'x'.repeat(32) } })).status, 401);
});

test('CORS: чужой сайт не получает разрешения', async () => {
  const r = await mf.dispatchFetch('http://worker/api/list', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const ok = await mf.dispatchFetch('http://worker/api/list', { method: 'OPTIONS', headers: { origin: ORIGIN } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
});
