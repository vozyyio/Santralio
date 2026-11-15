-- Santralio: web sitesi sohbet aracı (aynı yapay zekâ asistanı, yazılı).
--
-- İşletme sitesine tek satır kod ekler: <script src="https://api.<alan>/api/chat/embed.js" data-key="wk_..." async></script>
-- Sohbet penceresi api alan adındaki bir iframe'dir; yalnızca izin verilen sitelerin içinde açılır (frame-ancestors).
-- Asistan, seçilen yapay zekâ akışının bilgilerini ve (açıksa) rezervasyon hizmetlerini kullanır.

CREATE TABLE chat_widgets (
  tenant_id      integer PRIMARY KEY REFERENCES tenants(id),
  public_key     text NOT NULL UNIQUE CHECK (public_key ~ '^wk_[a-z0-9]{24}$'),
  enabled        boolean NOT NULL DEFAULT false,
  flow           text NOT NULL CHECK (flow ~ '^[a-z0-9_]{1,32}$'),
  title          text NOT NULL DEFAULT 'Canlı destek' CHECK (length(title) BETWEEN 1 AND 60),
  greeting       text NOT NULL DEFAULT '' CHECK (length(greeting) <= 300),
  color          text NOT NULL DEFAULT '#1d6fe8' CHECK (color ~ '^#[0-9a-f]{6}$'),
  origins        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(origins) <= 10),
  contact_phone  text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[0-9]{8,15}$'),
  whatsapp       text CHECK (whatsapp IS NULL OR whatsapp ~ '^\+[0-9]{8,15}$'),
  daily_limit    integer NOT NULL DEFAULT 300 CHECK (daily_limit BETWEEN 10 AND 5000),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_sessions (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id),
  token_hash     bytea NOT NULL UNIQUE,
  ip             text,
  page           text,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handoff', 'ended', 'limit')),
  history        jsonb NOT NULL DEFAULT '[]',
  tool_state     jsonb,
  messages       integer NOT NULL DEFAULT 0,
  language       text,
  summary        text,
  booking_ref    text,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_sessions_tenant ON chat_sessions (tenant_id, created_at DESC);
CREATE INDEX chat_sessions_ip ON chat_sessions (ip, created_at DESC);
