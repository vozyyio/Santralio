-- Santralio: menü, zamanlama ve giriş noktaları doğrudan bir dahiliyi de çaldırabilir (ext:<numara>).
-- Dahiliye ulaşılamazsa arayana kiracının "dahiliye ulaşılamıyor" anonsu çalınır.

ALTER TABLE tenants ADD COLUMN ext_unavailable_text text NOT NULL
  DEFAULT 'Aradığınız kişiye şu anda ulaşılamıyor. Lütfen daha sonra tekrar arayınız.'
  CHECK (length(ext_unavailable_text) BETWEEN 1 AND 500);

ALTER TABLE entry_points DROP CONSTRAINT entry_points_flow_check;
ALTER TABLE entry_points ADD CONSTRAINT entry_points_flow_check
  CHECK (flow ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$' OR flow ~ '^ext:[0-9]{2,6}$');
ALTER TABLE menus DROP CONSTRAINT menus_default_target_check;
ALTER TABLE menus ADD CONSTRAINT menus_default_target_check
  CHECK (default_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$' OR default_target ~ '^ext:[0-9]{2,6}$');
ALTER TABLE menu_options DROP CONSTRAINT menu_options_target_check;
ALTER TABLE menu_options ADD CONSTRAINT menu_options_target_check
  CHECK (target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$' OR target ~ '^ext:[0-9]{2,6}$');
ALTER TABLE schedules DROP CONSTRAINT schedules_open_target_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_open_target_check
  CHECK (open_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$' OR open_target ~ '^ext:[0-9]{2,6}$');
ALTER TABLE schedules DROP CONSTRAINT schedules_closed_target_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_closed_target_check
  CHECK (closed_target ~ '^(queue|menu|schedule):[a-z0-9_]{1,32}$' OR closed_target ~ '^ext:[0-9]{2,6}$');
