// Сервер целиком: настоящий воркер в Miniflare (локальный Cloudflare) с настоящей базой D1.
// Вместо Telegram — подставной сервер, который запоминает, куда бот отправлял фото.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { signInitData } from '../worker/src/auth.js';
import { jpegWithExif } from './exif-fixture.js';

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
  if (fileM) {
    // Файлы-документы с «exif» в имени — настоящий JPEG с датой и местом съёмки.
    if (fileM[1].includes('exif')) return new Response(jpegWithExif(), { headers: { 'content-type': 'image/jpeg' } });
    return new Response(`IMG:${fileM[1]}`, { headers: { 'content-type': 'application/octet-stream' } });
  }
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
    else if (method === 'deleteMessage') {
      // Сообщение №10 «старое» — Telegram не даёт боту его удалить.
      sent.push({ method, chat_id: Number(body.chat_id), message_id: body.message_id });
      if (body.message_id === 10) return Response.json({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted for everyone" });
      return Response.json({ ok: true, result: true });
    } else if (method === 'sendMediaGroup') result = JSON.parse(body.media).map(() => msg({ photo: photo('g' + msgId) }));
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
  const sql = readdirSync('worker/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync('worker/migrations/' + f, 'utf8'))
    .join(';\n')
    .replace(/--.*$/gm, '');
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
  message: { message_id, date: 1700000000 + message_id, from: { id: from, is_bot: false, first_name: 'T' }, chat: { id: from, type: 'private' }, photo: [{ file_id: `u${from}_${message_id}`, file_unique_id: `uu${from}_${message_id}`, width: 1280, height: 960 }], ...extra },
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

test('архив: от старых фото к новым, без повторов, до момента создания ключа', async () => {
  const U = 555;
  const created = await (await api('/api/auto/key', { user: U, method: 'POST' })).json();
  const auth = { authorization: 'Key ' + created.key };
  const since = async () => (await api('/api/auto/archive', { headers: auth })).text();
  const send = (body, taken, url = '/api/upload?archive=1') => {
    const form = new FormData();
    form.set('mode', 'photo');
    form.set('file', jpeg(body));
    if (taken) form.set('taken', taken);
    return api(url, { headers: auth, method: 'POST', body: form });
  };

  // сначала — со всех фото
  assert.equal(await since(), '1900-01-01T00:00:00Z');
  // архив — только по ключу, не из приложения
  const fromApp = new FormData();
  fromApp.set('file', jpeg('a'));
  assert.equal((await api('/api/upload?archive=1', { user: U, method: 'POST', body: fromApp })).status, 400);
  // без даты съёмки архив не знает, докуда дошёл
  assert.equal((await send('nodate')).status, 400);

  // это фото уже загружено кнопкой «Загрузить» (снято в ту же секунду) — архив его пропустит
  const manual = new FormData();
  manual.set('f0', jpeg('manual'));
  manual.set('meta', JSON.stringify([{ taken: Date.parse('2015-06-01T12:00:00Z') }]));
  assert.equal((await api('/api/upload', { user: U, method: 'POST', body: manual })).status, 200);

  sent.length = 0;
  let r = await (await send('old1', '2014-03-01T10:00:00+03:00')).json();
  assert.equal(r.items[0].t, Date.parse('2014-03-01T07:00:00Z'));
  assert.equal(r.items[0].o, 'archive');
  assert.equal(await since(), '2014-03-01T06:59:59Z');
  // то же фото ещё раз (последнее фото прошлого запуска) — не задвоится, даже если байты другие
  assert.equal((await (await send('old1-again', '2014-03-01T10:00:00+03:00')).json()).skipped, 1);
  // уже загруженное другим путём
  assert.equal((await (await send('manual-copy', '2015-06-01T15:00:00+03:00')).json()).skipped, 1);
  assert.equal(await since(), '2015-06-01T11:59:59Z');
  assert.equal(sent.length, 1);

  // обычная автозагрузка своей датой не сдвигается
  const info = await (await api('/api/auto/key', { user: U })).json();
  assert.equal(info.cursor, null);
  assert.deepEqual({ count: info.archive.count, done: info.archive.done }, { count: 1, done: false });

  // дошли до фото, снятых после создания ключа, — их везёт автозагрузка, архив закончен
  const done = await (await send('new', new Date(Date.now() + 60000).toISOString())).json();
  assert.equal(done.done, true);
  assert.equal(sent.length, 1);
  assert.equal(await since(), '2100-01-01T00:00:00Z');
  assert.equal((await (await api('/api/auto/key', { user: U })).json()).archive.done, true);
});

test('дата и место съёмки: из файла, присланного боту, и из загрузки без данных приложения', async () => {
  const C = 333;
  await hook({
    update_id: 500,
    message: { message_id: 500, date: 1700000000, from: { id: C, first_name: 'T' }, chat: { id: C, type: 'private' }, document: { file_id: 'doc_exif', file_unique_id: 'doc_exif_u', file_name: 'IMG_1.JPG', mime_type: 'image/jpeg', file_size: 3000 } },
  });
  // сжатое фото из чата — даты съёмки нет, остаётся дата сообщения
  await hook(photoMsg(C, 501));
  let items = (await listOf(C)).items;
  assert.equal(items[0].t, Date.parse('2023-07-15T14:30:00+03:00'));
  assert.equal(items[0].la, 55.76);
  assert.equal(items[0].lo, 37.62);
  assert.equal(items[1].t, (1700000000 + 501) * 1000);
  assert.equal(items[1].la, undefined);

  // загрузка без meta (как из «Быстрой команды»): дату и место сервер читает из самого файла
  const form = new FormData();
  form.set('file', new File([jpegWithExif({ date: '2024:01:02 10:00:00' })], 'IMG_2.jpg', { type: 'image/jpeg' }));
  const body = await (await api('/api/upload', { user: C, method: 'POST', body: form })).json();
  assert.equal(body.items[0].t, Date.parse('2024-01-02T10:00:00+03:00'));
  assert.equal(body.items[0].la, 55.76);
  assert.equal(body.items[0].o, 'app');
});

test('HEIC с iPhone из «Быстрой команды» без конвертации уходит файлом, дата и место — из самого файла', async () => {
  const D = 444;
  const { key } = await (await api('/api/auto/key', { user: D, method: 'POST' })).json();
  sent.length = 0;
  const form = new FormData();
  form.set('mode', 'photo'); // забыли шаг «Конвертировать» — сервер сам отправит файлом
  form.set('file', new File([readFileSync('test/fixtures/iphone.heic')], 'IMG_0001.HEIC', { type: 'image/heic' }));
  const r = await api('/api/upload', { headers: { authorization: 'Key ' + key }, method: 'POST', body: form });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(sent, [{ method: 'sendDocument', chat_id: D }]);
  const it = (await r.json()).items[0];
  assert.equal(it.k, 'd');
  assert.equal(it.t, Date.parse('2023-07-15T14:30:00+03:00'));
  assert.equal(it.la, 55.76);
  assert.equal(it.lo, 37.62);
  assert.equal(it.o, 'auto');
  // и курсор автозагрузки сдвинулся на дату этого снимка
  assert.equal(await (await api('/api/auto/since', { headers: { authorization: 'Key ' + key } })).text(), '2023-07-15T11:29:59Z');
});

test('лёгкая копия оригинала: открывается быстро, оригинал остаётся, в чате нет дублей', async () => {
  const P = 666;
  const doc = (extra = {}) => ({
    update_id: 700,
    message: { message_id: 700, date: 1700000000, from: { id: P, first_name: 'T' }, chat: { id: P, type: 'private' }, document: { file_id: 'heicdoc', file_unique_id: 'hu', file_name: 'IMG_7.HEIC', mime_type: 'image/heic', file_size: 2800000 }, ...extra },
  });
  await hook(doc());
  let list = await listOf(P);
  const it = list.items[0];
  assert.equal(it.k, 'd');
  assert.equal(it.v, undefined);
  const getFile = async (size, token = list.fileToken) => (await mf.dispatchFetch(`http://worker/api/file/${it.i}?s=${size}&k=${encodeURIComponent(token)}`)).text();
  assert.equal(await getFile('large'), 'IMG:photos/heicdoc.jpg'); // пока копии нет — сам оригинал

  const preview = () => {
    const f = new FormData();
    f.set('file', new File(['jpeg-preview'], 'preview.jpg', { type: 'image/jpeg' }));
    f.set('w', '4032');
    f.set('h', '3024');
    return f;
  };
  // чужое фото — как несуществующее
  assert.equal((await api(`/api/photo/${it.i}/preview`, { user: A, method: 'POST', body: preview() })).status, 404);

  sent.length = 0;
  const r = await api(`/api/photo/${it.i}/preview`, { user: P, method: 'POST', body: preview() });
  assert.equal(r.status, 200, await r.clone().text());
  const saved = (await r.json()).item;
  assert.equal(saved.v, 1);
  assert.deepEqual([saved.w, saved.h], [4032, 3024]);
  // копия ушла сжатым фото и сразу удалена из чата
  assert.deepEqual(sent.map((x) => x.method), ['sendPhoto', 'deleteMessage']);

  list = await listOf(P);
  assert.equal(list.items[0].v, 1);
  assert.match(await getFile('large'), /^IMG:photos\/p\d+_y\.jpg$/);
  assert.match(await getFile('thumb'), /^IMG:photos\/p\d+_/); // своей обложки у HEIC не было — взяли из копии
  assert.equal(await getFile('orig'), 'IMG:photos/heicdoc.jpg');

  // второй раз не отправляется
  sent.length = 0;
  assert.equal((await (await api(`/api/photo/${it.i}/preview`, { user: P, method: 'POST', body: preview() })).json()).item, null);
  assert.equal(sent.length, 0);
  // правка подписи в чате копию не сбрасывает
  await hook({ update_id: 701, edited_message: { ...doc().message, caption: 'море' } });
  list = await listOf(P);
  assert.equal(list.items[0].v, 1);
  assert.equal(list.items[0].c, 'море');

  // у оригинала с обложкой от Telegram «средний» размер — обложка, а не сам файл (сетка не качает мегабайты)
  await hook({
    update_id: 703,
    message: { message_id: 703, date: 1700000000, from: { id: P, first_name: 'T' }, chat: { id: P, type: 'private' }, document: { file_id: 'jpgdoc', file_unique_id: 'ju', file_name: 'IMG_9.JPG', mime_type: 'image/jpeg', file_size: 4000000, thumbnail: { file_id: 'jpgcover', file_unique_id: 'jc', width: 320, height: 240 } } },
  });
  list = await listOf(P);
  const withCover = list.items.find((x) => x.n === 'IMG_9.JPG');
  const medium = await (await mf.dispatchFetch(`http://worker/api/file/${withCover.i}?s=medium&k=${encodeURIComponent(list.fileToken)}`)).text();
  assert.equal(medium, 'IMG:photos/jpgcover.jpg');

  // сжатому фото копия не нужна
  await hook(photoMsg(P, 702));
  const photoId = (await listOf(P)).items.find((x) => x.k === 'p').i;
  assert.equal((await api(`/api/photo/${photoId}/preview`, { user: P, method: 'POST', body: preview() })).status, 400);

  // «Загрузить» оригиналом: копия прикрепляется сразу
  sent.length = 0;
  const up = new FormData();
  up.set('mode', 'doc');
  up.set('f0', new File(['orig-bytes-2'], 'IMG_8.HEIC', { type: 'image/heic' }));
  up.set('v0', new File(['jpeg-2'], 'v0.jpg', { type: 'image/jpeg' }));
  up.set('meta', JSON.stringify([{ taken: Date.parse('2024-01-01T10:00:00Z'), w: 3024, h: 4032 }]));
  const ur = await (await api('/api/upload', { user: P, method: 'POST', body: up })).json();
  assert.equal(ur.items[0].v, 1);
  assert.deepEqual([ur.items[0].w, ur.items[0].h], [3024, 4032]);
  assert.deepEqual(sent.map((x) => x.method), ['sendDocument', 'sendPhoto', 'deleteMessage']);
});

test('канал владельца: подключение, фото из канала, удаление там же', async () => {
  const O = 777;
  const CH = -1001234567890;
  const member = (status, from = O, extra = {}) => ({
    update_id: 900,
    my_chat_member: { chat: { id: CH, type: 'channel', title: 'Мои фото' }, from: { id: from, is_bot: false, first_name: 'T' }, date: 1700000000, old_chat_member: { status: 'left', user: { id: 1, is_bot: true } }, new_chat_member: { status, user: { id: 1, is_bot: true }, ...extra } },
  });
  const post = (message_id, extra = {}) => ({
    update_id: 900 + message_id,
    channel_post: { message_id, date: 1700000500, chat: { id: CH, type: 'channel', title: 'Мои фото' }, photo: [{ file_id: `ch_${message_id}`, file_unique_id: `chu_${message_id}`, width: 1280, height: 960 }], ...extra },
  });

  // пока канал не подключён — фото оттуда не берём
  await hook(post(5));
  assert.equal((await listOf(O)).items.length, 0);

  // бота сделали администратором — канал привязан к тому, кто это сделал, бот сообщает об этом
  const r = await (await hook(member('administrator', O, { can_post_messages: true, can_delete_messages: true }))).json();
  assert.equal(r.method, 'sendMessage');
  assert.equal(r.chat_id, O);
  assert.match(r.text, /Мои фото/);

  await hook(post(5));
  // в личном чате тот же номер сообщения — это другое фото, оба сохраняются
  await hook(photoMsg(O, 5));
  let items = (await listOf(O)).items;
  assert.equal(items.length, 2);
  const fromChannel = items.find((x) => x.o === 'channel');
  assert.ok(fromChannel);
  // чужие пользователи фото из канала не видят
  assert.equal((await listOf(A)).items.some((x) => x.o === 'channel'), false);

  // удаление — в самом канале
  sent.length = 0;
  const del = await (await api(`/api/photo/${fromChannel.i}`, { user: O, method: 'DELETE' })).json();
  assert.equal(del.chat, 'deleted');
  assert.deepEqual(sent, [{ method: 'deleteMessage', chat_id: CH, message_id: 5 }]);
  assert.equal((await listOf(O)).items.length, 1);

  // без права удалять — бот предупреждает
  const warn = await (await hook(member('administrator', O, { can_post_messages: true, can_delete_messages: false }))).json();
  assert.match(warn.text, /Удалять сообщения/);

  // бота убрали из администраторов — новые фото из канала больше не берём
  const bye = await (await hook(member('left', O))).json();
  assert.equal(bye.chat_id, O);
  await hook(post(6));
  assert.equal((await listOf(O)).items.length, 1);
});

test('повторы: то же фото ещё раз в чат или в канал в галерею не попадает', async () => {
  const D = 888;
  const CH = -1009999;
  await hook({ update_id: 950, my_chat_member: { chat: { id: CH, type: 'channel', title: 'Дубли' }, from: { id: D, is_bot: false, first_name: 'T' }, date: 1, old_chat_member: { status: 'left', user: { id: 1, is_bot: true } }, new_chat_member: { status: 'administrator', can_delete_messages: true, user: { id: 1, is_bot: true } } } });
  const doc = (file_unique_id, extra = {}) => ({ file_id: 'f_' + file_unique_id, file_unique_id, file_name: 'IMG_0333.HEIC', mime_type: 'image/heic', file_size: 2647805, ...extra });
  const dm = (message_id, document) => ({ update_id: 950 + message_id, message: { message_id, date: 1700000000, from: { id: D, first_name: 'T' }, chat: { id: D, type: 'private' }, document } });
  const post = (message_id, document) => ({ update_id: 970 + message_id, channel_post: { message_id, date: 1700000000, chat: { id: CH, type: 'channel' }, document } });

  await hook(dm(1, doc('same')));
  await hook(post(1, doc('same'))); // тот же файл опубликовали в канале
  await hook(post(2, doc('other-upload'))); // тот же файл, загруженный заново: другой отпечаток, но имя и размер те же
  await hook(dm(2, doc('different', { file_size: 123456 }))); // другое фото с тем же именем — это не повтор
  // правка подписи у самого первого сообщения — это не повтор, подпись обновляется
  await hook({ update_id: 999, edited_message: { ...dm(1, doc('same')).message, caption: 'колёса' } });
  // пересланное сжатое фото: тот же отпечаток самого большого размера
  const ph = (message_id) => ({ update_id: 990 + message_id, message: { message_id, date: 1700000000, from: { id: D, first_name: 'T' }, chat: { id: D, type: 'private' }, photo: [{ file_id: `p${message_id}`, file_unique_id: 'photo-same', width: 1280, height: 960 }] } });
  await hook(ph(3));
  await hook(ph(4));

  const items = (await listOf(D)).items;
  assert.equal(items.length, 3);
  assert.equal(items.find((x) => x.s === 2647805).c, 'колёса');
});

test('удаление: своё — из галереи и из чата, чужое — нельзя, старое сообщение — только из галереи', async () => {
  const before = (await listOf(A)).items;
  const last = before[before.length - 1];
  // B не может удалить фото A
  assert.equal((await api(`/api/photo/${last.i}`, { user: B, method: 'DELETE' })).status, 404);
  assert.equal((await listOf(A)).items.length, before.length);
  // без входа — тоже нельзя
  assert.equal((await api(`/api/photo/${last.i}`, { method: 'DELETE' })).status, 401);

  sent.length = 0;
  const r = await (await api(`/api/photo/${last.i}`, { user: A, method: 'DELETE' })).json();
  assert.equal(r.chat, 'deleted');
  assert.equal(sent[0].method, 'deleteMessage');
  assert.equal(sent[0].chat_id, A);
  assert.ok(!(await listOf(A)).items.some((it) => it.i === last.i));
  // файл удалённого фото больше не отдаётся
  const { fileToken } = await listOf(A);
  assert.equal((await api(`/api/file/${last.i}?k=${fileToken}`)).status, 404);

  // сообщение №10 «старое»: из галереи пропадает, в чате остаётся — приложение подскажет удалить его вручную
  const first = (await listOf(A)).items[0];
  const r2 = await (await api(`/api/photo/${first.i}`, { user: A, method: 'DELETE' })).json();
  assert.equal(r2.chat, 'kept');
  assert.ok(!(await listOf(A)).items.some((it) => it.i === first.i));
});

test('CORS: чужой сайт не получает разрешения', async () => {
  const r = await mf.dispatchFetch('http://worker/api/list', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const ok = await mf.dispatchFetch('http://worker/api/list', { method: 'OPTIONS', headers: { origin: ORIGIN } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
});
