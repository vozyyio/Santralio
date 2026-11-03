-- Santralio: çalışma saatleri ve tatiller.
-- Zamanlama bir yönlendirme hedefidir (schedule:<ad>): mesai içinde open_target'a gider,
-- mesai dışında ve tatil günlerinde kapalı anonsunu çalar, sonra closed_target'a gider ya da kapatır.

CREATE TABLE schedules (
  id             serial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id),
  name           text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,32}$'),
  timezone       text NOT NULL DEFAULT 'Europe/Istanbul' CHECK (timezone ~ '^[A-Za-z_]+(/[A-Za-z_+-]+)*$'),
  open_target    text NOT NULL CHECK (open_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$'),
  closed_text    text NOT NULL CHECK (length(closed_text) BETWEEN 1 AND 1000),
  closed_target  text CHECK (closed_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$'),
  UNIQUE (tenant_id, name)
);

-- Açık olunan aralıklar. Bir zamanlamanın birden fazla aralığı olabilir (ör. öğle arası için iki satır).
CREATE TABLE schedule_hours (
  id           serial PRIMARY KEY,
  schedule_id  integer NOT NULL REFERENCES schedules(id),
  weekdays     text NOT NULL CHECK (weekdays ~ '^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$'),
  opens        time NOT NULL,
  closes       time NOT NULL CHECK (closes > opens),
  UNIQUE (schedule_id, weekdays, opens, closes)
);

-- Tam gün kapalı tarihler (resmî tatil, bayram). Yerel saat dilimine göre değerlendirilir.
CREATE TABLE schedule_holidays (
  schedule_id  integer NOT NULL REFERENCES schedules(id),
  day          date NOT NULL,
  note         text,
  PRIMARY KEY (schedule_id, day)
);

-- Menüler ve giriş noktaları artık zamanlamaya da yönlenebilir.
ALTER TABLE entry_points DROP CONSTRAINT entry_points_flow_check;
ALTER TABLE entry_points ADD CONSTRAINT entry_points_flow_check CHECK (flow ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$');
ALTER TABLE menus DROP CONSTRAINT menus_default_target_check;
ALTER TABLE menus ADD CONSTRAINT menus_default_target_check CHECK (default_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$');
ALTER TABLE menu_options DROP CONSTRAINT menu_options_target_check;
ALTER TABLE menu_options ADD CONSTRAINT menu_options_target_check CHECK (target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$');
