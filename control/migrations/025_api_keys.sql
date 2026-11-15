-- Santralio: işletmenin kendi sistemleri için API anahtarları.
-- Anahtar yalnızca oluşturulurken bir kez gösterilir; veritabanında sha256 özeti tutulur.
-- Anahtarın yetkileri oluşturan kişinin yetkilerinin alt kümesidir; ayar ve personel yetkisi verilemez (bkz. apikeys.ts).

CREATE TABLE api_keys (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  key_prefix    text NOT NULL CHECK (key_prefix ~ '^sk_[a-z0-9]{8}$'),
  token_hash    text NOT NULL UNIQUE,
  permissions   text[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 10),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_tenant ON api_keys (tenant_id);
