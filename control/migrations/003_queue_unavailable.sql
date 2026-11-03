-- Santralio: kuyruğa girilemediğinde ya da bekleme süresi dolduğunda arayana çalınan anons.
ALTER TABLE queues ADD COLUMN unavailable_text text NOT NULL
  DEFAULT 'Şu anda size yardımcı olabilecek müsait temsilcimiz bulunmamaktadır. Lütfen daha sonra tekrar arayınız.'
  CHECK (length(unavailable_text) BETWEEN 1 AND 500);
