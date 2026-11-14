-- Santralio: kiracının kendi sistemlerine imzalı olay bildirimi (webhook).
--
-- Olaylar önce webhook_deliveries'e yazılır (outbox); işi doğuran işlemle aynı transaction'da.
-- Gönderici her 10 saniyede bekleyenleri alır, HMAC-SHA256 ile imzalar ve POST eder.
-- Başarısızsa 1 dk, 5 dk, 30 dk, 2 sa, 12 sa, 24 sa sonra yeniden dener; sonra "failed".
-- Adres yalnızca https ve genel internet (iç ağa çözülen adres reddedilir; bağlantı anında da denetlenir).
-- Gizli anahtar sunucuda üretilir, bir kez gösterilir, AES-256-GCM ile şifreli saklanır (imzalamak için gerekir).

CREATE TABLE webhooks (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  url             text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 500),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  events          text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 30),
  secret_enc      bytea NOT NULL,
  key_id          text NOT NULL,
  -- AAD: şifreli anahtar yalnızca bu satırda çözülür.
  secret_ref      text NOT NULL UNIQUE CHECK (secret_ref ~ '^[a-z0-9]{24}$'),
  enabled         boolean NOT NULL DEFAULT true,
  -- Arka arkaya başarısız teslim sayısı; 50'de uç kendiliğinden kapanır.
  fail_streak     integer NOT NULL DEFAULT 0,
  disabled_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX webhooks_tenant ON webhooks (tenant_id);

CREATE TABLE webhook_deliveries (
  id              bigserial PRIMARY KEY,
  webhook_id      integer NOT NULL,
  tenant_id       integer NOT NULL,
  event_id        text NOT NULL CHECK (event_id ~ '^evt_[a-z0-9]{24}$'),
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_at         timestamptz NOT NULL DEFAULT now(),
  last_code       integer,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (webhook_id, event_id),
  FOREIGN KEY (webhook_id, tenant_id) REFERENCES webhooks (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);

-- Görüşme olayları queue_log'dan okunur; nerede kalındığı burada tutulur.
CREATE TABLE event_cursors (
  name     text PRIMARY KEY,
  last_id  bigint NOT NULL
);

-- Yapay zekâ akışı arayanı tanısın mı (CRM kartı, önceki aramalar, son özet). Varsayılan açık.
ALTER TABLE ai_flows ADD COLUMN recognize_callers boolean NOT NULL DEFAULT true;
