// Один раз после установки: связывает бота с сервером.
//  - setWebhook: Telegram будет присылать новые сообщения боту на ваш сервер (с секретом);
//  - setChatMenuButton: кнопка «Галерея» слева от поля ввода в чате с ботом;
//  - setMyCommands: команда /start в меню.
//
// Запуск:  npm run setup-bot
// Скрипт сам спросит токен бота (ввод не виден на экране и не попадает в историю команд).
// Секрет вебхука берётся из файла .webhook-secret, адрес галереи — из wrangler.toml.
// Всё можно задать и переменными: BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, WEBAPP_URL.
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const root = new URL('..', import.meta.url);
const fromFile = (name) => (existsSync(new URL(name, root)) ? readFileSync(new URL(name, root), 'utf8').trim() : '');
const toml = fromFile('wrangler.toml');
const tomlVar = (name) => toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || '';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '');
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const BOT_TOKEN = process.env.BOT_TOKEN || (await ask('Токен бота от @BotFather (ввод не виден): ', { hidden: true }));
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || fromFile('.webhook-secret');
const WORKER_URL = process.env.WORKER_URL || fromFile('.worker-url') || (await ask('Адрес сервера (https://tg-photo-bot.….workers.dev): '));
const WEBAPP_URL = process.env.WEBAPP_URL || tomlVar('WEBAPP_URL');

const missing = Object.entries({ BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, WEBAPP_URL })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error('Не хватает: ' + missing.join(', ') + '. См. README, шаг 6.');
  process.exit(1);
}
if (!/^\d+:[\w-]{30,}$/.test(BOT_TOKEN)) {
  console.error('Это не похоже на токен бота. Он выглядит так: 123456789:AAE…');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
  console.error('WEBHOOK_SECRET может состоять только из латинских букв, цифр, «_» и «-» (до 256 символов).');
  process.exit(1);
}

async function call(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  console.log(`✓ ${method}`);
  return data.result;
}

const me = await call('getMe', {});
console.log(`Бот: @${me.username}`);
const worker = WORKER_URL.replace(/\/+$/, '');
await call('setWebhook', {
  url: `${worker}/tg/webhook`,
  secret_token: WEBHOOK_SECRET,
  allowed_updates: ['message', 'edited_message'],
});
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Галерея', web_app: { url: WEBAPP_URL } } });
await call('setMyCommands', { commands: [{ command: 'start', description: 'Открыть галерею' }] });
const info = await call('getWebhookInfo', {});
console.log(`\nВебхук: ${info.url}${info.last_error_message ? `\nПоследняя ошибка: ${info.last_error_message}` : ''}`);
console.log(`Готово. Откройте https://t.me/${me.username} и напишите /start.`);
