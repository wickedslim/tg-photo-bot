// Проверка подписи initData и токенов для файлов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, signInitData, makeFileToken, verifyFileToken, AuthError } from '../worker/src/auth.js';

const TOKEN = '123456:TEST-token';
const now = Date.now();
const fresh = Math.floor(now / 1000) - 60;
const user = { id: 111, first_name: 'Аня' };

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof AuthError && e.code === code);

test('правильная initData проходит и даёт номер пользователя', async () => {
  const data = await signInitData({ auth_date: fresh, query_id: 'AAA', user }, TOKEN);
  const { user: u } = await verifyInitData(data, TOKEN, { now });
  assert.equal(u.id, 111);
});

test('initData, подписанная другим ботом, не проходит', async () => {
  const data = await signInitData({ auth_date: fresh, user }, '999:OTHER');
  await rejects(verifyInitData(data, TOKEN, { now }), 'bad_hash');
});

test('подмена пользователя ломает подпись', async () => {
  const data = await signInitData({ auth_date: fresh, user }, TOKEN);
  const forged = data.replace(encodeURIComponent('"id":111'), encodeURIComponent('"id":222'));
  assert.notEqual(forged, data);
  await rejects(verifyInitData(forged, TOKEN, { now }), 'bad_hash');
});

test('без подписи или с мусором — отказ', async () => {
  await rejects(verifyInitData('', TOKEN), 'no_init_data');
  await rejects(verifyInitData(`auth_date=${fresh}&user=${encodeURIComponent(JSON.stringify(user))}`, TOKEN), 'bad_hash');
  await rejects(verifyInitData(`auth_date=${fresh}&hash=${'0'.repeat(64)}`, TOKEN), 'bad_hash');
});

test('устаревшая initData не проходит', async () => {
  const old = await signInitData({ auth_date: fresh - 2 * 86400, user }, TOKEN);
  await rejects(verifyInitData(old, TOKEN, { now }), 'expired');
  // а с большим допуском — проходит
  await verifyInitData(old, TOKEN, { now, maxAge: 3 * 86400 });
});

test('initData «из будущего» не проходит', async () => {
  const future = await signInitData({ auth_date: fresh + 3600, user }, TOKEN);
  await rejects(verifyInitData(future, TOKEN, { now }), 'bad_auth_date');
});

test('поле signature: подходит подпись и с ним, и без него', async () => {
  const withSig = await signInitData({ auth_date: fresh, signature: 'abc', user }, TOKEN);
  await verifyInitData(withSig, TOKEN, { now });
  // клиент подписал без signature, а потом поле добавилось
  const noSig = await signInitData({ auth_date: fresh, user }, TOKEN);
  await verifyInitData(noSig + '&signature=abc', TOKEN, { now });
});

test('без пользователя — отказ', async () => {
  const data = await signInitData({ auth_date: fresh, query_id: 'x' }, TOKEN);
  await rejects(verifyInitData(data, TOKEN, { now }), 'bad_user');
});

test('токен для файлов: свой проходит, подделка и просроченный — нет', async () => {
  const { token } = await makeFileToken(111, TOKEN, { now });
  assert.equal(await verifyFileToken(token, TOKEN, { now }), 111);
  const [, exp, sig] = token.split('.');
  await rejects(verifyFileToken(`222.${exp}.${sig}`, TOKEN, { now }), 'bad_token');
  await rejects(verifyFileToken(token, '999:OTHER', { now }), 'bad_token');
  await rejects(verifyFileToken(token, TOKEN, { now: now + 2 * 86400 * 1000 }), 'expired');
  await rejects(verifyFileToken('мусор', TOKEN), 'bad_token');
});
