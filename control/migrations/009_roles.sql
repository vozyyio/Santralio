-- Santralio: kiracının kendi tanımladığı roller ve yetkiler.
-- Kiracı kullanıcılarının (tenant_user) yetkileri rolden gelir; rol adı serbesttir ("Patron", "Hasta Danışmanı"…).
-- Platform ve bayi yöneticileri kiracı rollerinin dışındadır: kapsamlarındaki kiracılarda bütün yetkilere sahiptir.
-- Yetki kataloğu: control/src/permissions.ts

CREATE TABLE roles (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  permissions  text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  -- Kullanıcının rolü kendi kiracısından olmak zorunda (users üzerindeki bileşik yabancı anahtar).
  UNIQUE (id, tenant_id)
);

-- Her kiracı için başlangıç rolleri. Kiracı bunları yeniden adlandırabilir, değiştirebilir, yenilerini ekleyebilir.
INSERT INTO roles (tenant_id, name, permissions)
SELECT t.id, r.name, r.permissions
  FROM tenants t
 CROSS JOIN (VALUES
   ('Patron', ARRAY['agent.desk', 'agent.outbound', 'calls.own', 'calls.all', 'recordings.listen', 'reports.view', 'audit.view', 'crm.use', 'settings.manage', 'staff.manage']),
   ('Müdür', ARRAY['agent.desk', 'agent.outbound', 'calls.own', 'calls.all', 'recordings.listen', 'reports.view', 'audit.view', 'crm.use', 'settings.manage', 'staff.manage']),
   ('Süpervizör', ARRAY['agent.desk', 'agent.outbound', 'calls.own', 'calls.all', 'recordings.listen', 'reports.view', 'crm.use']),
   ('Temsilci', ARRAY['agent.desk', 'calls.own', 'crm.use'])
 ) AS r(name, permissions);

-- Mevcut kullanıcılar: kiracı yöneticisi -> Patron, temsilci -> Temsilci.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users DROP CONSTRAINT users_check;
ALTER TABLE users ADD COLUMN role_id integer;
UPDATE users u SET role_id = r.id, role = 'tenant_user'
  FROM roles r WHERE r.tenant_id = u.tenant_id AND u.role = 'tenant_admin' AND r.name = 'Patron';
UPDATE users u SET role_id = r.id, role = 'tenant_user'
  FROM roles r WHERE r.tenant_id = u.tenant_id AND u.role = 'agent' AND r.name = 'Temsilci';

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('platform_admin', 'reseller_admin', 'tenant_user'));
ALTER TABLE users ADD CONSTRAINT users_scope_check CHECK (
  (role = 'platform_admin' AND reseller_id IS NULL AND tenant_id IS NULL AND role_id IS NULL) OR
  (role = 'reseller_admin' AND reseller_id IS NOT NULL AND tenant_id IS NULL AND role_id IS NULL) OR
  (role = 'tenant_user' AND tenant_id IS NOT NULL AND role_id IS NOT NULL)
);
ALTER TABLE users ADD CONSTRAINT users_role_tenant_fk FOREIGN KEY (role_id, tenant_id) REFERENCES roles (id, tenant_id);
