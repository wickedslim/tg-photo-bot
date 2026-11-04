-- Место съёмки (из EXIF оригинала или из приложения перед загрузкой) — для разделов «Места» и «Поездки».
ALTER TABLE photos ADD COLUMN lat REAL;
ALTER TABLE photos ADD COLUMN lon REAL;
