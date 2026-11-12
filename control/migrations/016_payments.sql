-- Santralio: ödeme modülü (lisans modülü "payments").
-- İşletme kendi bankasını / ödeme kuruluşunu bağlar; para ve kart bilgisi Santralio'ya uğramaz.
-- İlk aşama: ödeme bağlantısı (sağlayıcının güvenli sayfası). Tuşlama (dtmf) yalnızca sağlayıcının
-- güvenli tuşlama hizmetiyle ve işletmenin MOTO onayıyla açılabilir.

-- Bağlı sağlayıcılar. Kimlik bilgileri şifreli (AAD: payment_providers:<tenant>:<callback_key>); ekranda bir daha gösterilmez.
CREATE TABLE payment_providers (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  provider        text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,32}$'),
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  credentials_enc bytea NOT NULL,
  key_id          text NOT NULL,
  -- Geri bildirim adresindeki gizli parça: hangi kiracı/sağlayıcıya ait olduğunu bulur (imza ayrıca doğrulanır).
  callback_key    text NOT NULL UNIQUE CHECK (callback_key ~ '^[a-z0-9]{32}$'),
  enabled         boolean NOT NULL DEFAULT true,
  is_default      boolean NOT NULL DEFAULT false,
  moto_confirmed_at timestamptz,          -- işletme MOTO yetkisi ve sorumluluğunu onayladı (tuşlama için)
  moto_confirmed_by text,
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_error text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX payment_providers_default ON payment_providers (tenant_id) WHERE is_default;

-- SMS gönderim hesabı (ödeme bağlantısı için). Sağlayıcının kendi SMS servisi de seçilebilir.
CREATE TABLE payment_sms (
  tenant_id       integer PRIMARY KEY REFERENCES tenants(id),
  sender          text NOT NULL CHECK (sender IN ('netgsm', 'provider', 'none')),
  credentials_enc bytea,
  key_id          text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Ödeme profilleri: "Rezervasyon kaporası", "Fatura tahsilatı" gibi.
CREATE TABLE payment_profiles (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  name            text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,32}$'),
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 4 AND 120),
  provider_id     integer,
  amount_source   text NOT NULL CHECK (amount_source IN ('fixed', 'agent', 'lookup')),
  fixed_amount    numeric(12,2) CHECK (fixed_amount IS NULL OR fixed_amount > 0),
  max_amount      numeric(12,2) NOT NULL CHECK (max_amount > 0),
  currency        text NOT NULL DEFAULT 'TRY' CHECK (currency IN ('TRY', 'USD', 'EUR', 'GBP')),
  lookup_url      text,                   -- amount_source = lookup: işletmenin sistemi (https, genel adres)
  methods         text NOT NULL DEFAULT 'link' CHECK (methods IN ('link', 'dtmf', 'both')),
  max_installment integer NOT NULL DEFAULT 1 CHECK (max_installment BETWEEN 1 AND 12),
  expires_minutes integer NOT NULL DEFAULT 60 CHECK (expires_minutes BETWEEN 5 AND 10080),
  ask_text        text NOT NULL DEFAULT '',
  sms_text        text NOT NULL DEFAULT '',
  success_text    text NOT NULL DEFAULT '',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (provider_id, tenant_id) REFERENCES payment_providers (id, tenant_id),
  CHECK (amount_source <> 'fixed' OR fixed_amount IS NOT NULL),
  CHECK (fixed_amount IS NULL OR fixed_amount <= max_amount),
  CHECK (amount_source <> 'lookup' OR lookup_url ~ '^https://')
);

-- Ödeme talepleri. Tutar sunucuda belirlenir; "ödendi" yalnızca sağlayıcının doğrulanmış bildirimi
-- ya da sunucudan yapılan durum sorgusuyla yazılır.
CREATE TABLE payment_requests (
  id              bigserial PRIMARY KEY,
  public_id       text NOT NULL UNIQUE CHECK (public_id ~ '^pay_[a-z0-9]{20}$'),
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  provider_id     integer NOT NULL,
  profile_id      integer REFERENCES payment_profiles(id),
  call_id         text,
  contact_id      integer REFERENCES contacts(id),
  phone           text CHECK (phone IS NULL OR phone ~ '^\+[0-9]{8,15}$'),
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL,
  description     text NOT NULL CHECK (length(btrim(description)) BETWEEN 4 AND 200),
  method          text NOT NULL CHECK (method IN ('link', 'dtmf')),
  status          text NOT NULL CHECK (status IN ('created', 'sent', 'paid', 'failed', 'expired', 'cancelled')),
  provider_ref    text,
  link_url        text,
  sms_status      text CHECK (sms_status IN ('sent', 'failed', 'skipped')),
  card_last4      text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  paid_amount     numeric(12,2),
  error           text,
  created_by      text NOT NULL CHECK (created_by IN ('agent', 'ai', 'ivr', 'api')),
  created_by_user text,
  expires_at      timestamptz NOT NULL,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_id, tenant_id) REFERENCES payment_providers (id, tenant_id)
);
CREATE INDEX payment_requests_tenant ON payment_requests (tenant_id, created_at DESC);
CREATE INDEX payment_requests_open ON payment_requests (status, expires_at) WHERE status IN ('created', 'sent');
CREATE UNIQUE INDEX payment_requests_ref ON payment_requests (provider_id, provider_ref) WHERE provider_ref IS NOT NULL;

-- Sağlayıcı bildirimleri: aynı bildirim ikinci kez işlenmez.
CREATE TABLE payment_events (
  id              bigserial PRIMARY KEY,
  provider_id     integer NOT NULL REFERENCES payment_providers(id),
  dedupe_key      text NOT NULL,
  request_id      bigint REFERENCES payment_requests(id),
  outcome         text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, dedupe_key)
);

-- Mevcut rollere yeni yetkiler: yöneticiler ödeme ayarlarını yönetir, ekip ödeme isteyebilir.
UPDATE roles SET permissions = array(SELECT DISTINCT unnest(permissions || ARRAY['payments.manage', 'payments.request']))
  WHERE name IN ('Patron', 'Müdür');
UPDATE roles SET permissions = array(SELECT DISTINCT unnest(permissions || ARRAY['payments.request']))
  WHERE name IN ('Süpervizör', 'Temsilci');
