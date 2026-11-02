-- Santralio kontrol veritabanı: ilk şema.
-- Bkz. docs/architecture.md, "Veritabanı şeması" ve "Ek: Kanaldan bağımsız mimari".
-- Şifreli alanlar (secret_enc) AES-256-GCM ile uygulama tarafında şifrelenir.
-- Biçim: iv (12 bayt) | etiket (16 bayt) | şifreli metin. key_id hangi ana anahtarın kullanıldığını söyler.

CREATE TABLE tenants (
  id          serial PRIMARY KEY,
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^t[0-9]{1,6}$'),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE licenses (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL UNIQUE REFERENCES tenants(id),
  source          text NOT NULL CHECK (source IN ('vozyy', 'manual')),
  active          boolean NOT NULL DEFAULT true,
  valid_until     timestamptz,
  max_extensions  integer NOT NULL CHECK (max_extensions >= 0),
  max_channels    integer NOT NULL CHECK (max_channels >= 0),
  modules         text[] NOT NULL DEFAULT '{}',
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trunks (
  id             serial PRIMARY KEY,
  tenant_id      integer NOT NULL UNIQUE REFERENCES tenants(id),
  operator       text NOT NULL CHECK (operator ~ '^[a-z0-9_-]{1,32}$'),
  server         text NOT NULL CHECK (server ~ '^[A-Za-z0-9.-]{1,253}$'),
  port           integer NOT NULL DEFAULT 5060 CHECK (port BETWEEN 1 AND 65535),
  transport      text NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp', 'tcp')),
  username       text NOT NULL CHECK (username ~ '^[A-Za-z0-9._+-]{1,64}$'),
  secret_enc     bytea NOT NULL,
  key_id         text NOT NULL,
  -- Kayda özel, tahmin edilemez Contact kullanıcısı. Gelen INVITE bununla kiracıya eşlenir.
  contact_token  text NOT NULL UNIQUE CHECK (contact_token ~ '^[a-z0-9]{16,32}$'),
  enabled        boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queues (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,32}$'),
  number      text CHECK (number ~ '^[0-9]{2,6}$'),
  strategy    text NOT NULL DEFAULT 'rrmemory'
              CHECK (strategy IN ('ringall', 'rrmemory', 'leastrecent', 'fewestcalls', 'random', 'linear')),
  ring_s      integer NOT NULL DEFAULT 20 CHECK (ring_s BETWEEN 5 AND 120),
  max_wait_s  integer NOT NULL DEFAULT 300 CHECK (max_wait_s BETWEEN 10 AND 3600),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, number)
);

CREATE TABLE extensions (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id),
  number        text NOT NULL CHECK (number ~ '^[0-9]{2,6}$'),
  display_name  text NOT NULL DEFAULT '' CHECK (display_name !~ '["\r\n;]'),
  secret_enc    bytea NOT NULL,
  key_id        text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE queue_members (
  queue_id      integer NOT NULL REFERENCES queues(id),
  extension_id  integer NOT NULL REFERENCES extensions(id),
  penalty       integer NOT NULL DEFAULT 0 CHECK (penalty >= 0),
  PRIMARY KEY (queue_id, extension_id)
);

CREATE TABLE entry_points (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id),
  channel    text NOT NULL CHECK (channel IN ('voice', 'whatsapp', 'webchat')),
  address    text NOT NULL,
  trunk_id   integer REFERENCES trunks(id),
  flow       text NOT NULL CHECK (flow ~ '^queue:[a-z0-9_]{1,32}$'),
  enabled    boolean NOT NULL DEFAULT true,
  UNIQUE (channel, address),
  -- Ses için adres yalnızca rakamdan oluşan, ülke koduyla yazılmış numaradır (ör. 908501234567).
  CHECK (channel <> 'voice' OR address ~ '^[1-9][0-9]{7,14}$')
);

CREATE TABLE operator_ip_ranges (
  id        serial PRIMARY KEY,
  operator  text NOT NULL CHECK (operator ~ '^[a-z0-9_-]{1,32}$'),
  cidr      cidr NOT NULL,
  note      text,
  UNIQUE (operator, cidr)
);

CREATE TABLE interactions (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  channel         text NOT NULL CHECK (channel IN ('voice', 'whatsapp', 'webchat')),
  entry_point_id  integer REFERENCES entry_points(id),
  queue_id        integer REFERENCES queues(id),
  extension_id    integer REFERENCES extensions(id),
  external_id     text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  outcome         text
);
CREATE INDEX interactions_tenant_started ON interactions (tenant_id, started_at DESC);

CREATE TABLE ai_providers (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id),
  interface    text NOT NULL CHECK (interface IN ('stt', 'tts', 'llm')),
  provider     text NOT NULL,
  model        text,
  settings     jsonb NOT NULL DEFAULT '{}',
  secret_enc   bytea,
  key_id       text,
  is_fallback  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, interface, is_fallback)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  tenant_id  integer REFERENCES tenants(id),
  action     text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'
);
