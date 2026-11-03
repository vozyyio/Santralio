-- Santralio: temsilcinin mola durumu. Kuyruk üyeliği bu alanla "paused" olarak üretilir;
-- böylece Asterisk yeniden yüklense de temsilcinin seçtiği durum korunur.
ALTER TABLE extensions ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE extensions ADD COLUMN paused_reason text CHECK (length(paused_reason) <= 100);
