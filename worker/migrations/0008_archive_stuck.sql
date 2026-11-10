-- Архив застрял: iPhone зависает на каком-то снимке, и каждый запуск кончается на одном и том же месте.
-- moved  — когда отметка архива сдвигалась в последний раз, миллисекунды;
-- stall  — сколько запусков подряд дошли до сервера, а отметка не сдвинулась;
-- warned — отметка, о которой бот уже написал (чтобы не писать про одно место дважды).
ALTER TABLE archive_progress ADD COLUMN moved INTEGER;
ALTER TABLE archive_progress ADD COLUMN stall INTEGER NOT NULL DEFAULT 0;
ALTER TABLE archive_progress ADD COLUMN warned INTEGER;
UPDATE archive_progress SET moved = used;
