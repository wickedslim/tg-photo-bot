import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Адрес сервера берём из переменной сборки VITE_API_URL — только к нему (и к самому сайту) разрешены запросы.
const apiOrigin = (() => {
  try {
    return new URL(process.env.VITE_API_URL || '').origin;
  } catch {
    return '';
  }
})();

// Политика безопасности страницы (CSP). Даже если в приложение как-то попадёт чужой код,
// браузер не даст ему загрузить свои скрипты или отправить данные куда-то, кроме нашего сервера.
//  - скрипты: только наш сайт, официальный скрипт Telegram и маленький загрузчик ниже (по его хэшу);
//  - запросы: только наш сайт и наш сервер на Cloudflare;
//  - картинки: только наши и скачанные с сервера (blob:).
// В режиме разработки не добавляем — там Vite нужен свой вебсокет, а демо берёт фото с picsum.photos.
const csp = (loaderHash) =>
  [
    "default-src 'self'",
    `script-src 'self' https://telegram.org '${loaderHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self' blob:${apiOrigin ? ' ' + apiOrigin : ''}`,
    "worker-src 'none'",
    "font-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

// Загрузчик без перезагрузок.
// GitHub Pages разрешает хранить страницу в кэше 10 минут, а Telegram держит её и дольше. После обновления
// закэшированная страница ссылается на старые файлы, и раньше приложению приходилось перезагружаться
// (а перезагрузка в Telegram — это белая вспышка и скачок). Теперь страница не ссылается на файлы напрямую:
// крошечный загрузчик берёт их имена из version.json (всегда свежего, мимо кэша) и подключает их.
// Если сети нет — берёт имена, записанные в саму страницу.
const loader = (fallback) => `(function () {
  var d = document, done = false, fb = ${JSON.stringify(fallback)};
  function start(m) {
    if (done) return;
    done = true;
    var inject = function () {
      var l = d.createElement('link');
      l.rel = 'stylesheet';
      l.href = m.css;
      l.onload = l.onerror = function () {
        var s = d.createElement('script');
        s.type = 'module';
        s.src = m.js;
        d.head.appendChild(s);
      };
      d.head.appendChild(l);
    };
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', inject);
    else inject();
  }
  setTimeout(function () { start(fb); }, 2000);
  fetch('version.json', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (m) { start(m && m.js && m.css ? m : fb); })
    .catch(function () { start(fb); });
})();`;

// Имена входных файлов берём из самой собранной страницы (их туда вставляет Vite).
const entryFiles = (html) => {
  const js = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
  const css = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/)?.[1];
  return js && css ? { js, css } : null;
};
let built = null;

const shell = {
  name: 'shell',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const files = (built = entryFiles(html));
      if (!files) throw new Error('shell: не нашёл входной JS/CSS');
      const code = loader(files);
      const hash = 'sha256-' + createHash('sha256').update(code).digest('base64');
      return html
        .replace(/\s*<script type="module"[^>]*><\/script>/, '')
        .replace(/\s*<link rel="stylesheet"[^>]*>/, '')
        .replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
        .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp(hash)}" />`)
        .replace('</head>', `  <script>${code}</script>\n  </head>`);
    },
  },
  writeBundle(options) {
    if (built) writeFileSync(join(options.dir, 'version.json'), JSON.stringify(built));
  },
};

// base: './' — чтобы сайт работал на GitHub Pages по адресу вида https://user.github.io/repo/
export default defineConfig({
  base: './',
  plugins: [shell],
  build: { target: 'es2022' },
  server: { host: true },
});
