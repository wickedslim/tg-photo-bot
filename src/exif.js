// Дата съёмки из EXIF. Telegram стирает EXIF у сжатых фото, поэтому читаем дату сами перед загрузкой —
// иначе в галерее у всех фото была бы дата загрузки, а не съёмки.
// Ищем блок «Exif\0\0» в начале файла: так находится и в JPEG, и обычно в HEIC.

export async function takenDate(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    const at = findExif(buf);
    if (at < 0) return null;
    return parseTiff(new DataView(buf.buffer, at));
  } catch {
    return null;
  }
}

function findExif(b) {
  for (let i = 0; i < b.length - 10; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66 && b[i + 4] === 0 && b[i + 5] === 0) {
      const t = i + 6;
      if ((b[t] === 0x49 && b[t + 1] === 0x49) || (b[t] === 0x4d && b[t + 1] === 0x4d)) return t;
    }
  }
  return -1;
}

function parseTiff(v) {
  const le = v.getUint16(0) === 0x4949;
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const readIfd = (off) => {
    const tags = new Map();
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return tags;
  };
  const str = (t) => {
    if (!t || t.type !== 2) return null;
    const off = t.count > 4 ? u32(t.at) : t.at;
    let s = '';
    for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(off + i));
    return s;
  };
  const ifd0 = readIfd(u32(4));
  let date = null;
  let tz = null;
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const exif = readIfd(u32(exifPtr.at));
    date = str(exif.get(0x9003)) || str(exif.get(0x9004)); // DateTimeOriginal / DateTimeDigitized
    tz = str(exif.get(0x9011)); // OffsetTimeOriginal, например «+03:00»
  }
  date ||= str(ifd0.get(0x0132)); // DateTime
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(date || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (tz && /^[+-]\d\d:\d\d$/.test(tz)) {
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`);
    if (Number.isFinite(t)) return t;
  }
  // Без часового пояса — считаем, что снято в часовом поясе этого телефона.
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isFinite(t) && +y > 1990 ? t : null;
}
