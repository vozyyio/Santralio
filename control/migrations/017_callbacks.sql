-- Santralio: kaçan çağrıya otomatik yapay zekâ geri araması.
-- Kuyrukta kapatılan / süresi dolan / temsilci bulunamayan gelen çağrı, birkaç saniye içinde
-- kiracının hattından yapay zekâ ile geri aranır. Kurallar: yalnızca izinli saat aralığında,
-- aynı numara bekleme süresi içinde bir kez, en fazla N deneme, aramak istemeyenler listesi, eş zamanlı sınır.

CREATE TABLE callback_settings (
  tenant_id        integer PRIMARY KEY REFERENCES tenants(id),
  enabled          boolean NOT NULL DEFAULT false,
  ai_flow          text NOT NULL CHECK (ai_flow ~ '^[a-z0-9_]{1,32}$'),
  delay_s          integer NOT NULL DEFAULT 20 CHECK (delay_s BETWEEN 5 AND 3600),
  max_attempts     integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 5),
  retry_minutes    integer NOT NULL DEFAULT 10 CHECK (retry_minutes BETWEEN 2 AND 240),
  cooldown_hours   integer NOT NULL DEFAULT 6 CHECK (cooldown_hours BETWEEN 1 AND 168),
  max_age_minutes  integer NOT NULL DEFAULT 120 CHECK (max_age_minutes BETWEEN 5 AND 1440),
  max_concurrent   integer NOT NULL DEFAULT 1 CHECK (max_concurrent BETWEEN 1 AND 10),
  window_start     time NOT NULL DEFAULT '09:00',
  window_end       time NOT NULL DEFAULT '21:00',
  weekdays         integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}', -- ISO: 1 = Pazartesi
  timezone         text NOT NULL DEFAULT 'Europe/Istanbul',
  international    boolean NOT NULL DEFAULT false,              -- yurt dışı numaralar da aransın mı
  greeting_tr      text NOT NULL DEFAULT '',
  greeting_en      text NOT NULL DEFAULT '',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (window_start < window_end)
);

CREATE TABLE callback_jobs (
  id               bigserial PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id),
  phone            text NOT NULL CHECK (phone ~ '^\+[0-9]{8,15}$'),
  source_callid    text NOT NULL,
  reason           text NOT NULL CHECK (reason IN ('abandoned', 'timeout', 'no_agent')),
  missed_at        timestamptz NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'dialing', 'answered', 'no_answer', 'resolved', 'skipped', 'cancelled', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_at          timestamptz NOT NULL,
  last_attempt_at  timestamptz,
  ai_session_id    bigint REFERENCES ai_sessions(id),
  note             text,                 -- atlanma / sonuç açıklaması (ör. "başka çağrıda görüşüldü")
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_callid)
);
CREATE INDEX callback_jobs_due ON callback_jobs (status, next_at) WHERE status IN ('pending', 'dialing');
CREATE INDEX callback_jobs_phone ON callback_jobs (tenant_id, phone, created_at DESC);

-- Geri aranmak istemeyenler (yapay zekâ "beni aramayın" dediğinde ya da panelden eklenir).
CREATE TABLE callback_optout (
  tenant_id        integer NOT NULL REFERENCES tenants(id),
  phone            text NOT NULL CHECK (phone ~ '^\+[0-9]{8,15}$'),
  reason           text NOT NULL DEFAULT '',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone)
);
