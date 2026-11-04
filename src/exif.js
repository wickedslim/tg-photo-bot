// Дата съёмки и место — из начала файла (общий разборщик EXIF лежит в worker/src/exif.js).
import { readExif } from '../worker/src/exif.js';

export async function photoMeta(file) {
  try {
    return readExif(new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()));
  } catch {
    return {};
  }
}
