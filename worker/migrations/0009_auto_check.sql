-- Команда версии 2: перед обработкой каждого снимка спрашивает сервер, брать ли его (/api/auto/check),
-- и в конце сообщает, что запуск закончен (/api/auto/done).
ALTER TABLE auto_settings ADD COLUMN version INTEGER;      -- версия команды из последнего запуска (нет — старая, первая)
ALTER TABLE auto_settings ADD COLUMN net TEXT;             -- через что был подключён iPhone: 'wifi' или 'cell'
ALTER TABLE auto_settings ADD COLUMN wifi_only INTEGER NOT NULL DEFAULT 1; -- 1 — по мобильной сети не загружать (только команда версии 2)
ALTER TABLE auto_settings ADD COLUMN run_at INTEGER;       -- когда начался последний запуск (задание), миллисекунды
ALTER TABLE auto_settings ADD COLUMN done_at INTEGER;      -- когда последний раз запуск дошёл до конца
ALTER TABLE auto_settings ADD COLUMN pending TEXT;         -- снимок, который команда взяла, но ещё не прислала: «съёмка|создание», секунды
ALTER TABLE auto_settings ADD COLUMN pending_run INTEGER;  -- в каком запуске (run_at) его взяли последний раз
ALTER TABLE auto_settings ADD COLUMN pending_fails INTEGER NOT NULL DEFAULT 0; -- сколько запусков брали его и не прислали

-- Снимки, на которых iPhone зависает: сервер пропускает их, а бот сообщает дату, чтобы их можно было добавить вручную.
CREATE TABLE auto_skipped (
  user_id INTEGER NOT NULL,
  item TEXT NOT NULL,        -- «съёмка|создание», секунды
  taken TEXT,                -- дата съёмки, как её прислал iPhone (с его часовым поясом) — для сообщения
  at INTEGER NOT NULL,       -- когда пропустили
  PRIMARY KEY (user_id, item)
);
