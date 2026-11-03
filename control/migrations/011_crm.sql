-- Santralio: CRM. Müşteri kartları, telefon numaraları, sonuç kodları ve görüşme notları.
-- Telefonlar tek biçimde saklanır (control/src/outbound.ts normalizeNumber: "0532…", yurt dışı "0049…");
-- gelen aramadaki numara karta bu biçimle eşlenir. Kart kiracının bütün personeline ortaktır (crm.use).

CREATE TABLE contacts (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  company     text NOT NULL DEFAULT '' CHECK (length(company) <= 200),
  email       text NOT NULL DEFAULT '' CHECK (length(email) <= 200),
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX contacts_tenant_name ON contacts (tenant_id, lower(name));

-- Bir numara kiracı içinde tek bir karta aittir.
CREATE TABLE contact_phones (
  contact_id  integer NOT NULL,
  tenant_id   integer NOT NULL,
  phone       text NOT NULL CHECK (phone ~ '^[0-9]{4,20}$'),
  PRIMARY KEY (tenant_id, phone),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX contact_phones_contact ON contact_phones (contact_id);

-- Sonuç kodları (Çözüldü, Geri aranacak…). Kiracı panelden yönetir.
CREATE TABLE dispositions (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  sort        integer NOT NULL DEFAULT 0,
  enabled     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id)
);
INSERT INTO dispositions (tenant_id, name, sort)
SELECT t.id, d.name, d.sort FROM tenants t
 CROSS JOIN (VALUES ('Çözüldü', 1), ('Bilgi verildi', 2), ('Geri aranacak', 3), ('Satış', 4), ('Şikâyet', 5), ('Yanlış numara', 6)) AS d(name, sort);

-- Görüşme notları: interactions tablosu (kanaldan bağımsız) CRM alanlarıyla genişletilir.
-- external_id: sesli görüşmede queue_log callid'si (gelen aramada temsilci masası X-Santralio-CallId'den alır).
ALTER TABLE interactions ADD COLUMN contact_id integer;
ALTER TABLE interactions ADD COLUMN phone text CHECK (phone IS NULL OR phone ~ '^[0-9]{4,20}$');
ALTER TABLE interactions ADD COLUMN direction text CHECK (direction IN ('in', 'out'));
ALTER TABLE interactions ADD COLUMN disposition_id integer;
ALTER TABLE interactions ADD COLUMN note text NOT NULL DEFAULT '' CHECK (length(note) <= 5000);
ALTER TABLE interactions ADD COLUMN follow_up_at timestamptz;
ALTER TABLE interactions ADD COLUMN user_email text;
ALTER TABLE interactions ADD FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts (id, tenant_id) ON DELETE SET NULL (contact_id);
ALTER TABLE interactions ADD FOREIGN KEY (disposition_id, tenant_id) REFERENCES dispositions (id, tenant_id);
CREATE INDEX interactions_contact ON interactions (contact_id, started_at DESC);
CREATE INDEX interactions_external ON interactions (tenant_id, external_id);
CREATE INDEX interactions_follow_up ON interactions (tenant_id, follow_up_at) WHERE follow_up_at IS NOT NULL;
