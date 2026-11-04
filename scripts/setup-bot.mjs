// Один раз после установки: связывает бота с сервером.
//  - setWebhook: Telegram будет присылать новые сообщения боту на ваш сервер (с секретом);
//  - setChatMenuButton: кнопка «Галерея» слева от поля ввода в чате с ботом;
//  - setMyCommands: команда /start в меню.
//
// Запуск (значения подставьте свои):
//   BOT_TOKEN=123:ABC WEBHOOK_SECRET=... WORKER_URL=https://tg-photo-bot.xxx.workers.dev \
//   WEBAPP_URL=https://wickedslim.github.io/tg-photo-bot/ npm run setup-bot
const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, WEBAPP_URL } = process.env;
const missing = Object.entries({ BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, WEBAPP_URL })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error('Не хватает переменных: ' + missing.join(', ') + '\nПример запуска — в начале файла scripts/setup-bot.mjs и в README.');
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
console.log('Готово. Напишите боту /start.');
