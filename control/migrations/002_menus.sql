-- Santralio: tuşlamalı menüler (IVR).
-- Giriş noktası ya da menü seçeneği bir kuyruğa (queue:<ad>) veya başka bir menüye (menu:<ad>) gider.
-- Anons metni burada durur; ses dosyası apply sırasında metinden üretilir.

CREATE TABLE menus (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  name            text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,32}$'),
  prompt_text     text NOT NULL CHECK (length(prompt_text) BETWEEN 1 AND 1000),
  invalid_text    text NOT NULL DEFAULT 'Geçersiz bir seçim yaptınız.' CHECK (length(invalid_text) BETWEEN 1 AND 500),
  timeout_s       integer NOT NULL DEFAULT 5 CHECK (timeout_s BETWEEN 1 AND 30),
  max_tries       integer NOT NULL DEFAULT 3 CHECK (max_tries BETWEEN 1 AND 10),
  default_target  text CHECK (default_target ~ '^(queue|menu):[a-z0-9_]{1,32}$'),
  UNIQUE (tenant_id, name)
);

CREATE TABLE menu_options (
  menu_id  integer NOT NULL REFERENCES menus(id),
  digit    text NOT NULL CHECK (digit ~ '^[0-9*#]$'),
  target   text NOT NULL CHECK (target ~ '^(queue|menu):[a-z0-9_]{1,32}$'),
  PRIMARY KEY (menu_id, digit)
);

-- Giriş noktaları artık menüye de bağlanabilir.
ALTER TABLE entry_points DROP CONSTRAINT entry_points_flow_check;
ALTER TABLE entry_points ADD CONSTRAINT entry_points_flow_check CHECK (flow ~ '^(queue|menu):[a-z0-9_]{1,32}$');
