// Полноэкранный просмотр на PhotoSwipe в стиле iPhone:
// сразу показываем уже загруженную миниатюру, параллельно грузим большой вариант,
// соседние фото подгружаются заранее. Тап — спрятать/показать панели (фон становится чёрным).
import PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';
import { pushBack, openExternal, haptic, downloadViaTelegram } from './tg.js';
import { isAbort } from './api.js';
import { dayLabel } from './grid.js';

const BIG = 'large';
const SMALL = ['medium', 'thumb'];
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const fmtTime = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}

const ICONS = {
  back: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.25" fill="currentColor"/></svg>',
};

// host — сетка, из которой открыли фото: даёт миниатюру для анимации и прокручивается вслед за листанием.
export function openViewer({ items, index, thumbs, bigs, api, host, toast }) {
  const ratioOf = (it) => {
    const d = bigs.dims.get(it.p) || thumbs.dims.get(it.p) || (it.w && it.h ? [it.w, it.h] : null);
    return d ? d[0] / d[1] : null;
  };
  let pswp;
  let destroyed = false;
  const loading = new Map(); // index -> job

  function ensureBig(it, i) {
    if (loading.has(i) || bigs.peek(it, BIG)) return;
    const job = bigs.load(it, BIG);
    loading.set(i, job);
    job.promise
      .then(
        (url) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = img.onerror = () => {
              bigs.noteDims(it, img);
              resolve();
            };
            img.src = url;
          }),
      )
      .then(
        () => {
          loading.delete(i);
          if (!destroyed) {
            pswp.refreshSlideContent(i);
            if (pswp.currIndex === i) {
              updateLoading();
              prepareShare(it);
            }
          }
        },
        (e) => {
          loading.delete(i);
          if (!isAbort(e) && !destroyed && pswp.currIndex === i) {
            toast(e?.code === 'too_big' ? 'Файл больше 20 МБ — целиком его можно открыть только в чате с ботом' : 'Не удалось загрузить фото');
            updateLoading();
          }
        },
      );
  }

  function ensureThumb(it, i) {
    if (thumbs.peekAny(it, SMALL)) return;
    const job = thumbs.load(it, 'medium');
    job.promise.then((url) => {
      const img = new Image();
      img.onload = () => {
        thumbs.noteDims(it, img);
        if (!destroyed && !bigs.peek(it, BIG)) pswp.refreshSlideContent(i);
      };
      img.src = url;
    }, () => {});
  }

  const options = {
    dataSource: items,
    index,
    bgOpacity: 1,
    spacing: 0.06,
    loop: false,
    showHideAnimationType: 'zoom',
    zoom: false,
    close: false,
    counter: false,
    arrowPrev: false,
    arrowNext: false,
    preload: [1, 2],
    imageClickAction: 'toggle-controls',
    bgClickAction: 'toggle-controls',
    tapAction: 'toggle-controls',
    doubleTapAction: 'zoom',
    errorMsg: 'Фото не загрузилось',
    mainClass: 'ios-viewer',
    paddingFn: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
  pswp = new PhotoSwipe(options);

  pswp.addFilter('itemData', (it, i) => {
    const big = bigs.peek(it, BIG);
    const thumb = thumbs.peekAny(it, SMALL);
    const r = ratioOf(it) || 4 / 3;
    const d = bigs.dims.get(it.p);
    const width = d ? d[0] : r >= 1 ? 1600 : Math.round(1600 * r);
    const height = d ? d[1] : r >= 1 ? Math.round(1600 / r) : 1600;
    if (!big) ensureBig(it, i);
    if (!thumb) ensureThumb(it, i);
    return { src: big || thumb || BLANK, msrc: thumb || undefined, width, height, alt: it.n || '', thumbCropped: true, _it: it };
  });
  pswp.addFilter('thumbEl', (elm, data, i) => host.thumbFor(i) || elm);

  // ── iOS-панели ──
  let infoOpen = false;
  pswp.on('uiRegister', () => {
    pswp.ui.registerElement({
      name: 'ios-top',
      appendTo: 'root',
      html: `<button class="v-btn v-back" aria-label="Назад">${ICONS.back}</button>
             <div class="v-title"><div class="v-date"></div><div class="v-time"></div></div>
             <span class="spinner small v-spin" hidden></span>`,
      onInit: (elm) => {
        elm.classList.add('v-bar', 'v-top');
        elm.querySelector('.v-back').addEventListener('click', () => pswp.close());
      },
    });
    pswp.ui.registerElement({
      name: 'ios-bottom',
      appendTo: 'root',
      html: `<button class="v-btn" data-act="share" aria-label="Поделиться">${ICONS.share}</button>
             <button class="v-btn" data-act="info" aria-label="Информация">${ICONS.info}</button>`,
      onInit: (elm) => {
        elm.classList.add('v-bar', 'v-bottom');
        elm.addEventListener('click', async (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          const it = items[pswp.currIndex];
          if (act === 'info') {
            infoOpen = !infoOpen;
            pswp.element.classList.toggle('info-open', infoOpen);
            haptic('light');
          } else if (act === 'share') {
            share(it);
          }
        });
      },
    });
    pswp.ui.registerElement({
      name: 'ios-info',
      appendTo: 'root',
      html: '',
      onInit: (elm) => elm.classList.add('v-info'),
    });
  });

  // ── «Поделиться», как на iPhone: сразу системное меню телефона с самим фото ──
  // В нём и отправка, и «Сохранить изображение» (в галерею). Файл готовим заранее, пока фото открыто:
  // системное меню открывается только в момент нажатия, ждать загрузку тогда уже нельзя.
  // Делимся тем, что уже загружено для просмотра; оригинал — кнопкой на панели ⓘ.
  const canShareFiles = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  let shareFile = null; // { p, file }
  let preparing = null;

  function prepareShare(it) {
    if (!canShareFiles || shareFile?.p === it.p || preparing === it.p) return;
    const url = bigs.peek(it, BIG);
    if (!url) return; // подготовим, когда загрузится большое фото
    preparing = it.p;
    fetch(url)
      .then((r) => r.blob())
      .then((b) => {
        const type = b.type && b.type.startsWith('image/') ? b.type : 'image/jpeg';
        const ext = type === 'image/jpeg' ? '.jpg' : '.' + type.split('/')[1];
        const f = new File([b], (it.n || `photo_${it.i}`).replace(/\.[^.]+$/, '') + ext, { type });
        if (navigator.canShare({ files: [f] })) shareFile = { p: it.p, file: f };
      })
      .catch(() => {})
      .finally(() => preparing === it.p && (preparing = null));
  }

  async function share(it) {
    if (!canShareFiles) return saveOriginal(it);
    if (shareFile?.p !== it.p) {
      prepareShare(it);
      return toast('Секунду, фото ещё загружается');
    }
    try {
      await navigator.share({ files: [shareFile.file] });
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Не получилось поделиться');
    }
  }

  // Файл скачивает сам Telegram, поэтому браузер не открывается.
  // Для оригиналов больше 20 МБ так не выйдет — Telegram не отдаёт ботам такие файлы.
  async function saveOriginal(it) {
    if (it.k === 'd' && it.s > 20 * 1024 * 1024) return toast('Файл больше 20 МБ — сохраните его из чата с ботом');
    const url = api.fileUrl(it, 'orig', { download: true });
    if (!(await downloadViaTelegram(url, it.n || `photo_${it.i}.jpg`))) openExternal(url);
  }

  function updateLoading() {
    const it = items[pswp.currIndex];
    pswp.element?.querySelector('.v-spin')?.toggleAttribute('hidden', Boolean(bigs.peek(it, BIG)));
  }

  function updateBars() {
    const it = items[pswp.currIndex];
    if (!it || !pswp.element) return;
    const d = new Date(it.t);
    const q = (s) => pswp.element.querySelector(s);
    q('.v-date').textContent = dayLabel(d);
    q('.v-time').textContent = fmtTime.format(d);
    // Имена файлов и подписи приходят из чата — только как текст, никогда как HTML.
    const row = (cls, a, b) => {
      const r = document.createElement('div');
      r.className = cls;
      for (const t of [a, b]) r.append(Object.assign(document.createElement('span'), { textContent: t }));
      return r;
    };
    const head = Object.assign(document.createElement('div'), { className: 'v-info-date', textContent: fmtFull.format(d) });
    const parts = [head, row('v-info-row', it.n || 'Фото', fmtSize(it.s)), row('v-info-row muted', 'Качество', it.k === 'd' ? 'оригинал, файлом' : 'сжатое Telegram')];
    if (it.c) parts.push(Object.assign(document.createElement('div'), { className: 'v-info-caption', textContent: it.c }));
    const orig = Object.assign(document.createElement('button'), { className: 'v-info-btn', textContent: it.k === 'd' ? 'Сохранить оригинал в Файлы' : 'Сохранить фото в Файлы' });
    orig.addEventListener('click', () => {
      haptic('light');
      saveOriginal(it);
    });
    parts.push(orig);
    q('.v-info').replaceChildren(...parts);
    prepareShare(it);
    updateLoading();
  }

  pswp.on('change', () => {
    updateBars();
    host.revealIndex(pswp.currIndex);
  });
  pswp.on('afterInit', updateBars);
  pswp.on('close', () => host.revealIndex(pswp.currIndex));
  const popBack = pushBack(() => pswp.close());
  pswp.on('destroy', () => {
    destroyed = true;
    for (const j of loading.values()) j.cancel();
    popBack();
  });

  pswp.init();
  return pswp;
}
