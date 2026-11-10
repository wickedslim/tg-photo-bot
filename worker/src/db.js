// Работа с базой D1: одна таблица photos, у каждой записи есть владелец user_id.
// Все запросы на чтение фильтруют по user_id — чужие фото не видны и не скачиваются.

const COLS = ['user_id', 'chat_id', 'message_id', 'date', 'taken', 'kind', 'width', 'height', 'size', 'name', 'mime', 'caption', 'media_group_id', 'thumb_id', 'medium_id', 'large_id', 'orig_id', 'sizes', 'hash', 'source', 'lat', 'lon', 'fuid'];

// pv — у оригинала (фото файлом) есть лёгкая копия для просмотра. Если правят подпись сообщения
// с тем же файлом (вебхук edited_message), копия сохраняется.
const ITEM_COLS = "id, date, taken, kind, width, height, size, name, caption, source, lat, lon, (kind = 'doc' AND large_id <> orig_id) AS pv";

const UPSERT = `INSERT INTO photos (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
  ON CONFLICT (chat_id, message_id) DO UPDATE SET
    kind = excluded.kind, size = excluded.size, name = excluded.name, mime = excluded.mime, caption = excluded.caption,
    width = COALESCE(excluded.width, photos.width), height = COALESCE(excluded.height, photos.height),
    taken = COALESCE(excluded.taken, photos.taken), lat = COALESCE(excluded.lat, photos.lat), lon = COALESCE(excluded.lon, photos.lon),
    thumb_id = CASE WHEN excluded.thumb_id = excluded.orig_id AND photos.orig_id = excluded.orig_id THEN photos.thumb_id ELSE excluded.thumb_id END,
    medium_id = CASE WHEN excluded.kind = 'doc' AND photos.orig_id = excluded.orig_id THEN photos.medium_id ELSE excluded.medium_id END,
    large_id = CASE WHEN excluded.kind = 'doc' AND photos.orig_id = excluded.orig_id THEN photos.large_id ELSE excluded.large_id END,
    orig_id = excluded.orig_id, sizes = excluded.sizes, hash = COALESCE(excluded.hash, photos.hash)
  RETURNING ${ITEM_COLS}`;

export function upsertStmt(db, userId, rec) {
  // chat_id не указан — сообщение в личном чате с ботом, его номер совпадает с номером пользователя.
  const row = { chat_id: userId, ...rec, user_id: userId };
  return db.prepare(UPSERT).bind(...COLS.map((c) => (row[c] === undefined ? null : row[c])));
}

export async function savePhotos(db, userId, recs) {
  if (!recs.length) return [];
  let res;
  try {
    res = await db.batch(recs.map((r) => upsertStmt(db, userId, r)));
  } catch (e) {
    // Редкий случай: то же фото параллельно загрузили дважды. Сообщение в чате уже есть —
    // запоминаем его без хэша, чтобы не потерять.
    if (!/UNIQUE/i.test(String(e?.message)) || !recs.some((r) => r.hash)) throw e;
    res = await db.batch(recs.map((r) => upsertStmt(db, userId, { ...r, hash: null })));
  }
  return res.map((r) => r.results[0]).filter(Boolean);
}

export async function listPhotos(db, userId, { after = 0, limit = 2000 } = {}) {
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLS} FROM photos WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(userId, after, limit)
    .all();
  return results;
}

export function getPhoto(db, userId, id) {
  return db
    .prepare('SELECT id, kind, size, mime, name, thumb_id, medium_id, large_id, orig_id FROM photos WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first();
}

// Компактный вид записи для приложения (полей file_id в ответе нет — они клиенту не нужны).
export function toItem(r) {
  const it = { i: r.id, t: r.taken || r.date * 1000, k: r.kind === 'doc' ? 'd' : 'p' };
  if (r.width) it.w = r.width;
  if (r.height) it.h = r.height;
  if (r.size) it.s = r.size;
  if (r.name) it.n = r.name;
  if (r.caption) it.c = r.caption;
  if (r.source && r.source !== 'chat') it.o = r.source;
  if (r.pv) it.v = 1;
  if (r.lat != null && r.lon != null) {
    it.la = r.lat;
    it.lo = r.lon;
  }
  return it;
}

export async function hasHash(db, userId, hash) {
  return Boolean(await db.prepare('SELECT 1 FROM photos WHERE user_id = ? AND hash = ?').bind(userId, hash).first());
}

// ── Ключи автозагрузки ──
export function keyInfo(db, userId) {
  return db.prepare('SELECT created, cursor, used FROM upload_keys WHERE user_id = ?').bind(userId).first();
}

export function setKey(db, userId, keyHash, now) {
  return db
    // Новый ключ взамен старого не сбрасывает, докуда дошла автозагрузка: иначе фото, снятые между последним
    // запуском и новым ключом, никогда бы не загрузились.
    .prepare('INSERT INTO upload_keys (user_id, key_hash, created) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET key_hash = excluded.key_hash, created = excluded.created')
    .bind(userId, keyHash, now)
    .run();
}

export function deleteKey(db, userId) {
  return db.prepare('DELETE FROM upload_keys WHERE user_id = ?').bind(userId).run();
}

export function userByKey(db, keyHash) {
  return db.prepare('SELECT user_id, created, cursor, used FROM upload_keys WHERE key_hash = ?').bind(keyHash).first();
}

// now = null — фото не сохранилось (повтор, скриншот): двигаем только отметку, used остаётся прежним.
export function touchKey(db, userId, now, cursor) {
  return db
    .prepare('UPDATE upload_keys SET used = COALESCE(?, used), cursor = MAX(COALESCE(cursor, 0), COALESCE(?, 0)) WHERE user_id = ?')
    .bind(now, cursor ?? null, userId)
    .run();
}

// ── Архив (старые фото командой «Архив») ──
export function archiveInfo(db, userId) {
  return db
    .prepare('SELECT cursor, used, moved, stall, warned, (SELECT COUNT(*) FROM photos WHERE user_id = ?1 AND source = ?2) AS count FROM archive_progress WHERE user_id = ?1')
    .bind(userId, 'archive')
    .first();
}

// Отметка сдвинулась вперёд — запоминаем когда и сбрасываем счётчик запусков без движения.
// (В SET все столбцы — ещё старые значения строки.)
export function touchArchive(db, userId, now, cursor) {
  return db
    .prepare(
      `INSERT INTO archive_progress (user_id, cursor, used, moved) VALUES (?1, ?3, ?2, ?2) ON CONFLICT (user_id) DO UPDATE SET
         used = ?2,
         moved = CASE WHEN cursor IS NULL OR ?3 > cursor THEN ?2 ELSE moved END,
         stall = CASE WHEN cursor IS NULL OR ?3 > cursor THEN 0 ELSE stall END,
         cursor = MAX(COALESCE(cursor, ?3), ?3)`,
    )
    .bind(userId, now, cursor)
    .run();
}

export function setArchiveStall(db, userId, stall, warned) {
  return db.prepare('UPDATE archive_progress SET stall = ?, warned = ? WHERE user_id = ?').bind(stall, warned ?? null, userId).run();
}

// Человек сам решил перешагнуть место, где архив застрял: продолжаем с выбранной даты.
export function skipArchive(db, userId, now, cursor) {
  return db.prepare('UPDATE archive_progress SET cursor = ?, moved = ?, stall = 0 WHERE user_id = ? AND cursor < ?').bind(cursor, now, userId, cursor).run();
}

// Есть ли уже фото, снятое в ту же секунду. Без withArchive смотрим только загруженные НЕ архивом
// (кнопкой, автозагрузкой, в чат): серийную съёмку (несколько кадров в секунду) из самого архива это не задевает.
export async function hasTakenAt(db, userId, taken, withArchive = false) {
  const s = Math.floor(taken / 1000) * 1000;
  const sql = 'SELECT 1 FROM photos WHERE user_id = ? AND taken >= ? AND taken < ?' + (withArchive ? '' : " AND source <> 'archive'");
  return Boolean(await db.prepare(sql).bind(userId, s, s + 1000).first());
}

// Лёгкая копия оригинала для просмотра: её размеры (из сжатого фото Telegram) — вместо оригинала.
// Обложку заменяем, только если своей у файла не было (например, HEIC: тогда обложкой был сам файл).
export function setPreview(db, userId, id, { thumb_id, medium_id, large_id, width, height }) {
  return db
    .prepare(
      `UPDATE photos SET thumb_id = CASE WHEN thumb_id = orig_id THEN ? ELSE thumb_id END, medium_id = ?, large_id = ?,
         width = COALESCE(width, ?), height = COALESCE(height, ?)
       WHERE id = ? AND user_id = ? AND kind = 'doc' RETURNING ${ITEM_COLS}`,
    )
    .bind(thumb_id, medium_id, large_id, width ?? null, height ?? null, id, userId)
    .first();
}

// ── Канал владельца ──
export function channelOwner(db, chatId) {
  return db.prepare('SELECT user_id, can_delete FROM channels WHERE chat_id = ?').bind(chatId).first();
}

export function channelOf(db, userId) {
  return db.prepare('SELECT chat_id, title, can_delete, added FROM channels WHERE user_id = ?').bind(userId).first();
}

// Один канал на владельца: подключили новый — он заменяет прежний (фото из прежнего остаются в галерее).
export function linkChannel(db, userId, chatId, title, canDelete, now) {
  return db.batch([
    db.prepare('DELETE FROM channels WHERE chat_id = ? AND user_id <> ?').bind(chatId, userId),
    db
      .prepare('INSERT INTO channels (user_id, chat_id, title, can_delete, added) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, title = excluded.title, can_delete = excluded.can_delete, added = excluded.added')
      .bind(userId, chatId, title, canDelete ? 1 : 0, now),
  ]);
}

export function unlinkChannel(db, chatId) {
  return db.prepare('DELETE FROM channels WHERE chat_id = ? RETURNING user_id, title').bind(chatId).first();
}

// Такое фото уже есть в галерее (не считая самого этого сообщения — например, при правке подписи)?
// Тот же файл по отпечатку Telegram, или файл-оригинал с тем же именем и размером.
export async function findDuplicate(db, userId, rec) {
  const conds = [];
  const args = [userId, rec.chat_id ?? userId, rec.message_id];
  if (rec.fuid) {
    conds.push('fuid = ?');
    args.push(rec.fuid);
  }
  if (rec.kind === 'doc' && rec.name && rec.size) {
    conds.push("(kind = 'doc' AND name = ? AND size = ?)");
    args.push(rec.name, rec.size);
  }
  if (!conds.length) return null;
  return db
    .prepare(`SELECT id FROM photos WHERE user_id = ? AND NOT (chat_id = ? AND message_id = ?) AND (${conds.join(' OR ')}) LIMIT 1`)
    .bind(...args)
    .first();
}

// Настройки автозагрузки (см. миграцию 0006). Нет строки — всё выключено.
export async function autoSettings(db, userId) {
  const r = await db.prepare('SELECT original, archive, last_new, last_archive FROM auto_settings WHERE user_id = ?').bind(userId).first();
  return { original: Boolean(r?.original), archive: Boolean(r?.archive), lastNew: r?.last_new ?? null, lastArchive: r?.last_archive ?? null };
}

export function saveAutoSettings(db, userId, { original, archive }) {
  return db
    .prepare('INSERT INTO auto_settings (user_id, original, archive) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET original = ?2, archive = ?3')
    .bind(userId, original ? 1 : 0, archive ? 1 : 0)
    .run();
}

export function touchNew(db, userId, now) {
  return db.prepare('INSERT INTO auto_settings (user_id, last_new) VALUES (?1, ?2) ON CONFLICT (user_id) DO UPDATE SET last_new = ?2').bind(userId, now).run();
}

// «Загрузить сейчас» в галерее: забываем время проверки, и следующий запуск сразу ищет новые снимки.
export function resumeAuto(db, userId) {
  return db.prepare('UPDATE auto_settings SET last_new = NULL WHERE user_id = ?').bind(userId).run();
}

export function touchOld(db, userId, now) {
  return db.prepare('UPDATE auto_settings SET last_archive = ? WHERE user_id = ?').bind(now, userId).run();
}
