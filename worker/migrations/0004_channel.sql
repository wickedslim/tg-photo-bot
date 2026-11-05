-- Фото могут лежать не только в личном чате с ботом, но и в приватном канале владельца.
-- Номер сообщения уникален только внутри своего чата, поэтому таблицу пересобираем
-- с колонкой chat_id и уникальностью (chat_id, message_id). Старые фото — из личного чата: chat_id = user_id.
CREATE TABLE photos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,          -- где лежит сообщение: личный чат (= user_id) или канал владельца
  message_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  taken INTEGER,
  kind TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size INTEGER,
  name TEXT,
  mime TEXT,
  caption TEXT,
  media_group_id TEXT,
  thumb_id TEXT NOT NULL,
  medium_id TEXT NOT NULL,
  large_id TEXT NOT NULL,
  orig_id TEXT NOT NULL,
  sizes TEXT NOT NULL,
  hash TEXT,
  source TEXT NOT NULL DEFAULT 'chat', -- 'chat', 'app', 'auto', 'archive', 'channel' — фото, опубликованное в канале
  lat REAL,
  lon REAL,
  UNIQUE (chat_id, message_id)
);
INSERT INTO photos_new (id, user_id, chat_id, message_id, date, taken, kind, width, height, size, name, mime, caption, media_group_id, thumb_id, medium_id, large_id, orig_id, sizes, hash, source, lat, lon)
  SELECT id, user_id, user_id, message_id, date, taken, kind, width, height, size, name, mime, caption, media_group_id, thumb_id, medium_id, large_id, orig_id, sizes, hash, source, lat, lon FROM photos;
DROP TABLE photos;
ALTER TABLE photos_new RENAME TO photos;
CREATE INDEX photos_by_user ON photos (user_id, id);
CREATE UNIQUE INDEX photos_by_hash ON photos (user_id, hash) WHERE hash IS NOT NULL;
CREATE INDEX photos_by_taken ON photos (user_id, taken);

-- Канал владельца: бот в нём администратор, всё, что там публикуется, — фото владельца.
CREATE TABLE channels (
  user_id INTEGER PRIMARY KEY,       -- владелец (тот, кто сделал бота администратором)
  chat_id INTEGER NOT NULL UNIQUE,   -- номер канала
  title TEXT,
  can_delete INTEGER NOT NULL DEFAULT 0, -- есть ли у бота право удалять сообщения
  added INTEGER NOT NULL             -- когда подключён, миллисекунды
);
