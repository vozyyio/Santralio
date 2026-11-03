-- Santralio: yapay zekâ karşılaması. Arayanı bir asistan karşılar, derdini anlar, kısa soruları yanıtlar,
-- uygun kuyruğa ya da dahiliye özetle aktarır. Ses: Azure Speech (STT, TTS); dil modeli: Claude.
-- Kiracı bazında yalnızca platform yöneticisi açar (ai_enabled); akışları kiracı yönetir.

ALTER TABLE tenants ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE ai_flows (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  name            text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,32}$'),
  enabled         boolean NOT NULL DEFAULT true,
  greeting_text   text NOT NULL CHECK (length(greeting_text) BETWEEN 1 AND 500),
  -- Asistanın bilmesi gerekenler: şirket, hizmetler, sık sorular, üslup. Arayana okunmaz.
  instructions    text NOT NULL DEFAULT '' CHECK (length(instructions) <= 8000),
  -- Aktarılabilecek yerler ve ne zaman: [{ "target": "queue:muhasebe", "description": "fatura, ödeme" }]
  routes          jsonb NOT NULL DEFAULT '[]',
  default_target  text CHECK (default_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$' OR default_target ~ '^ext:[0-9]{2,6}$'),
  max_turns       integer NOT NULL DEFAULT 4 CHECK (max_turns BETWEEN 1 AND 10),
  voice           text NOT NULL DEFAULT 'azure:tr-TR-EmelNeural' CHECK (voice ~ '^(azure|piper):[A-Za-z0-9_.-]{1,64}$'),
  model           text NOT NULL DEFAULT 'claude-haiku-5-5' CHECK (model ~ '^claude-[a-z0-9-]{1,40}$'),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE ai_sessions (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  flow            text NOT NULL,
  callid          text,
  caller          text,
  did             text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  route_target    text,
  -- Temsilciye bırakılan kısa özet (temsilci ekranında görünür).
  summary         text,
  transcript      jsonb NOT NULL DEFAULT '[]',
  end_reason      text,
  stt_seconds     numeric(8, 1) NOT NULL DEFAULT 0,
  tts_chars       integer NOT NULL DEFAULT 0,
  llm_input_tokens   integer NOT NULL DEFAULT 0,
  llm_output_tokens  integer NOT NULL DEFAULT 0,
  error           text
);
CREATE INDEX ai_sessions_tenant ON ai_sessions (tenant_id, started_at DESC);
CREATE INDEX ai_sessions_callid ON ai_sessions (tenant_id, callid);

-- Menüler, zamanlamalar ve numaralar yapay zekâ akışına da yönlenebilir (ai:<akış>).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('entry_points', 'entry_points_flow_check', 'flow'),
    ('menus', 'menus_default_target_check', 'default_target'),
    ('menu_options', 'menu_options_target_check', 'target'),
    ('schedules', 'schedules_open_target_check', 'open_target'),
    ('schedules', 'schedules_closed_target_check', 'closed_target')) AS t(tbl, con, col)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.con);
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I ~ '^(queue|menu|schedule|ai):[a-z0-9_]{1,32}$' OR %I ~ '^ext:[0-9]{2,6}$')$f$,
                   r.tbl, r.con, r.col, r.col);
  END LOOP;
END
$$;
