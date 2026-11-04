// Дата съёмки и место из EXIF. Общий код для приложения (читает файл перед загрузкой)
// и сервера (читает начало файла, присланного боту документом).
// Telegram стирает EXIF у сжатых фото, поэтому достать эти данные можно только из оригинала.
// Ищем блок «Exif\0\0» в начале файла: так он находится и в JPEG, и обычно в HEIC.

export function readExif(bytes) {
  try {
    const at = findExif(bytes);
    if (at < 0) return {};
    return parseTiff(new DataView(bytes.buffer, bytes.byteOffset + at, bytes.byteLength - at));
  } catch {
    return {};
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
  const rationals = (t) => {
    if (!t || t.type !== 5) return null;
    const off = u32(t.at);
    const out = [];
    for (let i = 0; i < t.count; i++) {
      const d = u32(off + i * 8 + 4);
      out.push(d ? u32(off + i * 8) / d : 0);
    }
    return out;
  };

  const out = {};
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
  if (m && +m[1] > 1990) {
    const [, y, mo, d, h, mi, s] = m;
    let t = NaN;
    if (tz && /^[+-]\d\d:\d\d$/.test(tz)) t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`);
    // Без часового пояса: на телефоне считаем, что снято в его часовом поясе, на сервере — по Москве.
    if (!Number.isFinite(t)) t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${typeof document === 'undefined' ? '+03:00' : ''}`);
    if (Number.isFinite(t)) out.taken = t;
  }

  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const gps = readIfd(u32(gpsPtr.at));
    const dms = (tag) => {
      const r = rationals(gps.get(tag));
      return r && r.length === 3 ? r[0] + r[1] / 60 + r[2] / 3600 : null;
    };
    const ref = (tag) => String.fromCharCode(v.getUint8(gps.get(tag)?.at ?? 0));
    let la = dms(0x0002);
    let lo = dms(0x0004);
    if (la != null && lo != null && (la || lo)) {
      if (gps.has(0x0001) && ref(0x0001) === 'S') la = -la;
      if (gps.has(0x0003) && ref(0x0003) === 'W') lo = -lo;
      if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) Object.assign(out, { la: +la.toFixed(6), lo: +lo.toFixed(6) });
    }
  }
  return out;
}
