-- Santralio: görüşme sonrası yapay zekâ analizi.
--
-- Yapay zekâ görüşmesi bittikten sonra dökümü ayrı bir modelle incelenir: özet, konu (kiracının konu listesinden),
-- müşterinin genel hali, sonuç (yapay zekâ çözdü / aktarıldı / çözülmedi) ve takip edilecek iş.
-- Analiz yapay zekâ servisinde (santralio-ai) çalışır; görüşmeyi geciktirmez. Kiracı açmadıkça çalışmaz (maliyet).

CREATE TABLE analysis_settings (
  tenant_id   integer PRIMARY KEY REFERENCES tenants(id),
  enabled     boolean NOT NULL DEFAULT false,
  model       text NOT NULL DEFAULT 'claude-sonnet-5-5' CHECK (model ~ '^claude-[a-z0-9-]{1,40}$'),
  -- Konu listesi: raporların tutarlı olması için model yalnızca bunlardan birini seçer ("diğer" her zaman var).
  topics      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(topics) <= 30),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE call_analyses (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id),
  ai_session_id  bigint NOT NULL UNIQUE REFERENCES ai_sessions(id) ON DELETE CASCADE,
  callid         text,
  status         text NOT NULL CHECK (status IN ('done', 'failed')),
  attempts       integer NOT NULL DEFAULT 1,
  summary        text,
  topic          text,
  sentiment      text CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  outcome        text CHECK (outcome IN ('ai_resolved', 'transferred', 'unresolved', 'unknown')),
  follow_up      text,
  model          text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_analyses_tenant ON call_analyses (tenant_id, created_at DESC);
