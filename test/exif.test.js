// Чтение даты съёмки и места из EXIF (общий код приложения и сервера).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExif } from '../worker/src/exif.js';
import { readFileSync } from 'node:fs';
import { jpegWithExif } from './exif-fixture.js';

test('дата съёмки с часовым поясом и место', () => {
  const ex = readExif(jpegWithExif());
  assert.equal(ex.taken, Date.parse('2023-07-15T14:30:00+03:00'));
  assert.equal(ex.la, 55.76);
  assert.equal(ex.lo, 37.62);
});

test('без часового пояса на сервере считаем по Москве', () => {
  const ex = readExif(jpegWithExif({ tz: 'xxxxxx' }));
  assert.equal(ex.taken, Date.parse('2023-07-15T14:30:00+03:00'));
});

test('нет EXIF или мусор — пусто, без ошибок', () => {
  assert.deepEqual(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), {});
  assert.deepEqual(readExif(new Uint8Array(1000).fill(7)), {});
  const broken = jpegWithExif();
  broken.fill(0xff, 20, 60);
  assert.doesNotThrow(() => readExif(broken));
});

test('настоящий HEIC (как с iPhone): дата и место', () => {
  const ex = readExif(new Uint8Array(readFileSync('test/fixtures/iphone.heic')));
  assert.equal(ex.taken, Date.parse('2023-07-15T14:30:00+03:00'));
  assert.equal(ex.la, 55.76);
  assert.equal(ex.lo, 37.62);
});
