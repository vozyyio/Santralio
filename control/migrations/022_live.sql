-- Santralio: canlı durum ekranı uyarı eşikleri (kiracı başına).
CREATE TABLE live_settings (
  tenant_id        integer PRIMARY KEY REFERENCES tenants(id),
  wait_alert_s     integer NOT NULL DEFAULT 60 CHECK (wait_alert_s BETWEEN 10 AND 1800),
  waiting_alert_n  integer NOT NULL DEFAULT 3 CHECK (waiting_alert_n BETWEEN 1 AND 100),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
