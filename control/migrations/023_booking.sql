-- Santralio: rezervasyon bağlantısı ve yapay zekâ ile rezervasyon alma.
--
-- Kiracı rezervasyon türlerini (hizmetleri) ve her birinin sorulacak alanlarını tanımlar.
-- Mod:
--   builtin: rezervasyon Santralio'da tutulur (sistemi olmayan işletme). Fiyat hizmette sabitse söylenir; yoksa
--            "temsilci teyit edecek" denir. Talep panelde onaylanır ya da iptal edilir.
--   api:     işletmenin kendi sistemi standart Santralio rezervasyon sözleşmesiyle (docs/booking-contract.md) sorulur:
--            quote (müsaitlik + fiyat), create, lookup (arayanın rezervasyonları), cancel. İstekler HMAC ile imzalı.
-- Yapay zekâ fiyat ve müsaitliği kendisi söyleyemez; yalnızca bu bağlantının döndürdüğünü okur.
-- Santralio üzerinden oluşan her rezervasyonun bir kopyası bookings tablosunda tutulur (geçmiş, panel, webhook).

CREATE TABLE booking_settings (
  tenant_id     integer PRIMARY KEY REFERENCES tenants(id),
  mode          text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'builtin', 'api')),
  api_url       text CHECK (api_url IS NULL OR (api_url ~ '^https://' AND length(api_url) <= 500)),
  secret_enc    bytea,
  key_id        text,
  secret_ref    text UNIQUE CHECK (secret_ref IS NULL OR secret_ref ~ '^[a-z0-9]{24}$'),
  -- [{key, label, description, fields:[{key,label,type,required,choices?}], price?, currency, payment: none|optional|required}]
  services      jsonb NOT NULL DEFAULT '[]',
  -- Rezervasyondan sonra ödeme bağlantısı hangi sağlayıcıdan (null: varsayılan sağlayıcı)
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id               bigserial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id),
  public_ref       text NOT NULL UNIQUE CHECK (public_ref ~ '^RZ[A-Z0-9]{8}$'),
  source           text NOT NULL CHECK (source IN ('phone', 'chat', 'panel', 'api')),
  service          text NOT NULL,
  service_label    text NOT NULL,
  fields           jsonb NOT NULL DEFAULT '{}',
  customer_name    text,
  phone            text,
  amount           numeric(12, 2),
  currency         text,
  status           text NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  external_ref     text,
  call_id          text,
  ai_session_id    bigint REFERENCES ai_sessions(id) ON DELETE SET NULL,
  payment_ref      text,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_tenant ON bookings (tenant_id, created_at DESC);
CREATE INDEX bookings_phone ON bookings (tenant_id, phone);

-- Yapay zekâ akışı rezervasyon alsın mı.
ALTER TABLE ai_flows ADD COLUMN booking boolean NOT NULL DEFAULT false;

-- Ödeme talebi rezervasyondan (tutar işletme sisteminden ya da hizmetten, sunucu tarafında) ve sohbetten de doğabilir.
ALTER TABLE payment_requests DROP CONSTRAINT payment_requests_created_by_check;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_created_by_check CHECK (created_by IN ('agent', 'ai', 'ivr', 'api', 'booking'));

-- Rezervasyonları görme, onaylama ve iptal etme yetkisi.
UPDATE roles SET permissions = array(SELECT DISTINCT unnest(permissions || ARRAY['bookings.manage']))
 WHERE name IN ('Patron', 'Müdür', 'Süpervizör');

-- Rezervasyon akışlarında konuşma daha uzun sürer.
ALTER TABLE ai_flows DROP CONSTRAINT ai_flows_max_turns_check;
ALTER TABLE ai_flows ADD CONSTRAINT ai_flows_max_turns_check CHECK (max_turns BETWEEN 1 AND 30);
