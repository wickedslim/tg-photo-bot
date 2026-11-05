-- Отпечаток файла от Telegram (file_unique_id оригинала или самого большого размера сжатого фото).
-- Одно и то же фото, присланное или пересланное ещё раз, в галерею второй раз не попадает.
ALTER TABLE photos ADD COLUMN fuid TEXT;
UPDATE photos SET fuid = json_extract(sizes, '$[#-1].u');
CREATE INDEX photos_by_fuid ON photos (user_id, fuid);
CREATE INDEX photos_by_name ON photos (user_id, name, size);
