-- Santralio: anons sesi seçimi, müşterinin kendi yüklediği anons kayıtları ve santrali açıp kapatma.

-- Anonsların üretildiği ses (control/src/voices.ts kataloğundan). Değişince bütün anonslar yeniden üretilir.
ALTER TABLE tenants ADD COLUMN tts_voice text NOT NULL DEFAULT 'piper:tr_TR-dfki-medium' CHECK (tts_voice ~ '^(piper|espeak):[A-Za-z0-9_.-]{1,64}$');

-- Santral kapalıyken gelen aramalar bu anonsu duyar ve kapanır (çalışma saatlerinden bağımsız).
ALTER TABLE tenants ADD COLUMN pbx_open boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN pbx_closed_text text NOT NULL
  DEFAULT 'Şu anda hizmet veremiyoruz. Lütfen daha sonra tekrar arayınız.'
  CHECK (length(pbx_closed_text) BETWEEN 1 AND 500);

-- Kiracının kendi yüklediği anons kayıtları: bu adlı anons metinden üretilmez, yüklenen ses çalınır.
CREATE TABLE prompt_uploads (
  tenant_id      integer NOT NULL REFERENCES tenants(id),
  name           text NOT NULL CHECK (name ~ '^[a-z0-9_-]{1,80}$'),
  original_name  text NOT NULL DEFAULT '' CHECK (length(original_name) <= 200),
  duration_s     numeric(6, 1),
  uploaded_by    text,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);
