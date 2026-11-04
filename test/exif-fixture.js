// Крошечный «JPEG» с EXIF: дата съёмки 15.07.2023 14:30 (+03:00) и место — Москва (55.76, 37.62).
export function jpegWithExif({ date = '2023:07:15 14:30:00', tz = '+03:00', lat = [55, 45, 36], lon = [37, 37, 12] } = {}) {
  const t = new DataView(new ArrayBuffer(198));
  let o = 0;
  const u16 = (v) => (t.setUint16(o, v), (o += 2));
  const u32 = (v) => (t.setUint32(o, v), (o += 4));
  const entry = (tag, type, count, value) => (u16(tag), u16(type), u32(count), u32(value));
  const ascii = (at, s) => [...s].forEach((c, i) => t.setUint8(at + i, c.charCodeAt(0)));

  u16(0x4d4d), u16(42), u32(8); // «MM», порядок байт big-endian, IFD0 с 8-го байта
  u16(2), entry(0x8769, 4, 1, 38), entry(0x8825, 4, 1, 96), u32(0); // IFD0: ссылки на EXIF и GPS
  u16(2), entry(0x9003, 2, 20, 68), entry(0x9011, 2, 7, 88), u32(0); // EXIF: дата и часовой пояс
  ascii(68, date + '\0');
  ascii(88, tz + '\0');
  o = 96;
  u16(4);
  entry(0x0001, 2, 2, 0x4e000000); // «N»
  entry(0x0002, 5, 3, 150);
  entry(0x0003, 2, 2, 0x45000000); // «E»
  entry(0x0004, 5, 3, 174);
  u32(0);
  o = 150;
  for (const v of [...lat, ...lon]) u32(v), u32(1);

  const tiff = new Uint8Array(t.buffer);
  const head = [0xff, 0xd8, 0xff, 0xe1, ((tiff.length + 8) >> 8) & 255, (tiff.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0];
  return new Uint8Array([...head, ...tiff, 0xff, 0xd9]);
}
