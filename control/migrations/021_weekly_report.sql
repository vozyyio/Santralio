-- Santralio: haftalık yapay zekâ raporu.
-- Geçen haftanın (Pazartesi–Pazar, İstanbul) görüşme analizlerinden yöneticiye kısa bir rapor yazılır:
-- öne çıkanlar, sorunlar, asistanın takıldığı yerler ve somut öneriler. Kiracı açmadıkça çalışmaz.

ALTER TABLE analysis_settings
  ADD COLUMN weekly_report boolean NOT NULL DEFAULT false,
  ADD COLUMN report_model  text NOT NULL DEFAULT 'claude-sonnet-5-5' CHECK (report_model ~ '^claude-[a-z0-9-]{1,40}$');

CREATE TABLE analysis_reports (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL CHECK (status IN ('done', 'failed')),
  attempts      integer NOT NULL DEFAULT 1,
  report        jsonb,            -- { headline, highlights[], problems[], suggestions[] }
  stats         jsonb NOT NULL DEFAULT '{}',
  model         text,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);
