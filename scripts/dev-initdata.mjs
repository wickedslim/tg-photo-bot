// Для проверки сервера на своём компьютере (`npm run worker:dev`): печатает initData, подписанную
// тестовым токеном из .dev.vars, — как будто приложение открыли в Telegram.
//   node scripts/dev-initdata.mjs [номер_пользователя]
//   curl -H "Authorization: tma $(node scripts/dev-initdata.mjs)" http://localhost:8787/api/list
import { readFileSync } from 'node:fs';
import { signInitData } from '../worker/src/auth.js';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!vars.BOT_TOKEN) throw new Error('В .dev.vars нет BOT_TOKEN');
const id = Number(process.argv[2] || 111);
console.log(await signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id, first_name: 'Тест' } }, vars.BOT_TOKEN));
