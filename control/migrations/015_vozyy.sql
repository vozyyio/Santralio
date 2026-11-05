-- Santralio: Vozyy lisans entegrasyonu (sözleşme v0.3).
-- Önek kuralı (^t[0-9]{1,6}$) değişmez; müşterinin istediği kısa ad ayrı "slug" sütunundadır.
ALTER TABLE tenants ADD COLUMN slug text UNIQUE
  CHECK (slug ~ '^[a-z0-9-]{3,30}$' AND slug NOT IN ('www', 'api', 'sip', 'panel', 'admin'));
-- cancelled: lisans iptal; kiracı kapalı, veri durur.
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'cancelled'));

-- Vozyy lisansları (hosted ve self_hosted). Vergi dairesi ve vergi numarası burada tutulmaz.
CREATE TABLE vozyy_licenses (
  license_id      text PRIMARY KEY CHECK (license_id ~ '^lic_[A-Za-z0-9_-]{1,64}$'),
  customer_id     text,
  plan            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('active', 'suspended', 'cancelled')),
  install_mode    text NOT NULL CHECK (install_mode IN ('hosted', 'self_hosted')),
  install_status  text NOT NULL CHECK (install_status IN ('awaiting_install', 'provisioned')),
  panel_domain    text,
  requested_slug  text,
  valid_from      timestamptz,
  valid_until     timestamptz,
  max_extensions  integer NOT NULL CHECK (max_extensions >= 0),
  max_channels    integer NOT NULL CHECK (max_channels >= 0),
  modules         text[] NOT NULL DEFAULT '{}',
  tenant_id       integer UNIQUE REFERENCES tenants(id),
  company_name    text NOT NULL DEFAULT '',
  contact_name    text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  phone           text NOT NULL DEFAULT '',
  sector          text,
  locale          text,
  last_event_at   timestamptz NOT NULL,   -- uygulanan son olayın occurred_at'i (sırasız olaylar için)
  last_checked_at timestamptz,            -- günlük doğrulama
  check_error     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Alınan olaylar: aynı event_id ikinci kez işlenmez, ilk yanıt döner.
CREATE TABLE vozyy_events (
  event_id     text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_-]{1,64}$'),
  event        text NOT NULL,
  license_id   text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  outcome      text NOT NULL,             -- applied | stale | ignored
  response     jsonb NOT NULL
);

-- İlk yönetici daveti. Bağlantı e-posta yoksa platform panelinde gösterilir: token şifreli saklanır.
CREATE TABLE user_invites (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  token_enc   bytea NOT NULL,
  key_id      text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  sent        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
