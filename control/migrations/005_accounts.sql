-- Santralio: bayiler, kullanıcı hesapları ve oturumlar.
-- Hiyerarşi: platform -> bayi -> kiracı (müşteri) -> temsilci.
-- Platform sahibi de bir bayi gibi tutulur (id 1): bayi kullanmayan kurulumda tüm kiracılar ona bağlıdır.

CREATE TABLE resellers (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO resellers (id, name) VALUES (1, 'Platform');
SELECT setval(pg_get_serial_sequence('resellers', 'id'), 1);

ALTER TABLE tenants ADD COLUMN reseller_id integer NOT NULL DEFAULT 1 REFERENCES resellers(id);

-- Roller ve kapsamları:
--   platform_admin : her şey
--   reseller_admin : reseller_id'ye bağlı kiracılar
--   tenant_admin   : tenant_id kiracısı
--   agent          : tenant_id kiracısında yalnızca kendi dahilisi (extension_id); yönetim yetkisi yok
CREATE TABLE users (
  id             serial PRIMARY KEY,
  email          text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name           text NOT NULL DEFAULT '',
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('platform_admin', 'reseller_admin', 'tenant_admin', 'agent')),
  reseller_id    integer REFERENCES resellers(id),
  tenant_id      integer REFERENCES tenants(id),
  extension_id   integer REFERENCES extensions(id),
  disabled       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (role = 'platform_admin' AND reseller_id IS NULL AND tenant_id IS NULL) OR
    (role = 'reseller_admin' AND reseller_id IS NOT NULL AND tenant_id IS NULL) OR
    (role = 'tenant_admin' AND tenant_id IS NOT NULL) OR
    (role = 'agent' AND tenant_id IS NOT NULL AND extension_id IS NOT NULL)
  )
);

-- Oturum belirteci istemcide durur; burada yalnızca SHA-256 özeti tutulur.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  revoked     boolean NOT NULL DEFAULT false
);
CREATE INDEX sessions_user ON sessions (user_id);
