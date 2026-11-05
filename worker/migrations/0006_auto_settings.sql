-- Настройки автозагрузки, которые человек меняет в галерее, а команда на iPhone узнаёт у сервера:
-- так их можно менять, не трогая саму команду.
CREATE TABLE auto_settings (
  user_id INTEGER PRIMARY KEY,
  original INTEGER NOT NULL DEFAULT 0,  -- 1 — отправлять оригиналы файлом, 0 — сжатые фото (JPEG до 2560 px)
  archive INTEGER NOT NULL DEFAULT 0,   -- 1 — заодно загружать старые фото (от самых старых к новым)
  last_new INTEGER                      -- когда команда в последний раз получала задание «новые фото», миллисекунды
);
