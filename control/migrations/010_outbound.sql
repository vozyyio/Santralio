-- Santralio: kiracı bazında dış arama politikası. Yalnızca platform yöneticisi değiştirir.
-- Kiracı, bu politikanın içinde, hangi rolün dış arama yapabileceğini "agent.outbound" yetkisiyle belirler.
-- Özel ücretli (0900 vb.) ve kısa numaralar politikadan bağımsız olarak her zaman engellidir.

CREATE TABLE outbound_policies (
  tenant_id         integer PRIMARY KEY REFERENCES tenants(id),
  template          text NOT NULL DEFAULT 'custom',
  enabled           boolean NOT NULL DEFAULT false,
  tr_mobile         boolean NOT NULL DEFAULT false,  -- 05xx
  tr_landline       boolean NOT NULL DEFAULT false,  -- 02xx, 03xx, 04xx
  tr_national       boolean NOT NULL DEFAULT false,  -- 0850, 444
  tr_tollfree       boolean NOT NULL DEFAULT false,  -- 0800
  -- Yurt dışı: izin verilen ülke kodları (ör. 49 Almanya, 44 Birleşik Krallık, 971 BAE). Boşsa yurt dışı kapalı.
  countries         text[] NOT NULL DEFAULT '{}' CHECK (countries::text ~ '^\{([1-9][0-9]{0,3}(,[1-9][0-9]{0,3})*)?\}$'),
  max_concurrent    integer NOT NULL DEFAULT 2 CHECK (max_concurrent BETWEEN 0 AND 100),
  daily_limit       integer NOT NULL DEFAULT 100 CHECK (daily_limit BETWEEN 0 AND 100000),
  max_minutes       integer NOT NULL DEFAULT 60 CHECK (max_minutes BETWEEN 1 AND 480),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text
);
INSERT INTO outbound_policies (tenant_id, template) SELECT id, 'inbound_only' FROM tenants;
