// Работа с базой D1: одна таблица photos, у каждой записи есть владелец user_id.
// Все запросы на чтение фильтруют по user_id — чужие фото не видны и не скачиваются.

const COLS = ['user_id', 'message_id', 'date', 'taken', 'kind', 'width', 'height', 'size', 'name', 'mime', 'caption', 'media_group_id', 'thumb_id', 'medium_id', 'large_id', 'orig_id', 'sizes', 'hash', 'source', 'lat', 'lon'];

const UPSERT = `INSERT INTO photos (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
  ON CONFLICT (user_id, message_id) DO UPDATE SET
    kind = excluded.kind, size = excluded.size, name = excluded.name, mime = excluded.mime, caption = excluded.caption,
    width = COALESCE(excluded.width, photos.width), height = COALESCE(excluded.height, photos.height),
    taken = COALESCE(excluded.taken, photos.taken), lat = COALESCE(excluded.lat, photos.lat), lon = COALESCE(excluded.lon, photos.lon),
    thumb_id = excluded.thumb_id, medium_id = excluded.medium_id, large_id = excluded.large_id, orig_id = excluded.orig_id,
    sizes = excluded.sizes, hash = COALESCE(excluded.hash, photos.hash)
  RETURNING id, date, taken, kind, width, height, size, name, caption, source, lat, lon`;

export function upsertStmt(db, userId, rec) {
  const row = { ...rec, user_id: userId };
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
    .prepare('SELECT id, date, taken, kind, width, height, size, name, caption, source, lat, lon FROM photos WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?')
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
    .prepare('INSERT INTO upload_keys (user_id, key_hash, created) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET key_hash = excluded.key_hash, created = excluded.created, cursor = NULL, used = NULL')
    .bind(userId, keyHash, now)
    .run();
}

export function deleteKey(db, userId) {
  return db.prepare('DELETE FROM upload_keys WHERE user_id = ?').bind(userId).run();
}

export function userByKey(db, keyHash) {
  return db.prepare('SELECT user_id, created, cursor FROM upload_keys WHERE key_hash = ?').bind(keyHash).first();
}

export function touchKey(db, userId, now, cursor) {
  return db
    .prepare('UPDATE upload_keys SET used = ?, cursor = MAX(COALESCE(cursor, 0), COALESCE(?, 0)) WHERE user_id = ?')
    .bind(now, cursor ?? null, userId)
    .run();
}
