-- Список фото каждого пользователя. Сами фото хранятся в Telegram (в чате пользователя с ботом),
-- здесь — только ссылки на них (file_id) и даты, чтобы показывать галерею.
CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,          -- кто владелец (номер пользователя Telegram = номер личного чата с ботом)
  message_id INTEGER NOT NULL,       -- номер сообщения с фото в этом чате
  date INTEGER NOT NULL,             -- когда сообщение отправлено, секунды
  taken INTEGER,                     -- когда снято (из EXIF, если загружали через приложение), миллисекунды
  kind TEXT NOT NULL,                -- 'photo' — сжатое фото, 'doc' — картинка файлом (оригинал)
  width INTEGER,
  height INTEGER,
  size INTEGER,                      -- размер самого большого варианта (для doc — оригинала), байты
  name TEXT,                         -- имя файла (для doc)
  mime TEXT,
  caption TEXT,
  media_group_id TEXT,               -- альбом, если фото пришли пачкой
  thumb_id TEXT NOT NULL,            -- file_id миниатюры (~320 px)
  medium_id TEXT NOT NULL,           -- file_id среднего размера (~800 px)
  large_id TEXT NOT NULL,            -- file_id самого большого сжатого варианта
  orig_id TEXT NOT NULL,             -- file_id оригинала (для photo совпадает с large_id)
  sizes TEXT NOT NULL,               -- JSON со всеми размерами: [{id, u, w, h, s}]
  hash TEXT,                         -- SHA-256 загруженного файла: одно и то же фото не загрузится дважды
  source TEXT NOT NULL DEFAULT 'chat', -- 'chat' — прислали боту руками, 'app' — из приложения, 'auto' — автозагрузка
  UNIQUE (user_id, message_id)
);

CREATE INDEX photos_by_user ON photos (user_id, id);
CREATE UNIQUE INDEX photos_by_hash ON photos (user_id, hash) WHERE hash IS NOT NULL;

-- Личные ключи автозагрузки (для «Быстрых команд» на iPhone). Храним только хэш ключа:
-- даже с доступом к базе сам ключ не узнать.
CREATE TABLE upload_keys (
  user_id INTEGER PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,          -- когда создан, миллисекунды
  cursor INTEGER,                    -- дата съёмки последнего фото, пришедшего автозагрузкой, миллисекунды
  used INTEGER                       -- когда ключом пользовались в последний раз
);
