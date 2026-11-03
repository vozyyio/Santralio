-- Santralio: arama kaydı ayarları ve kuyruk olayları (raporlar).

-- Kayıt kiracı bazında açılır; varsayılan kapalı. Açıkken arayan önce bilgilendirme anonsunu duyar.
-- Saklama süresi dolan kayıtlar her gece silinir (santralio recordings purge, KVKK).
ALTER TABLE tenants ADD COLUMN recording_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN recording_retention_days integer NOT NULL DEFAULT 90 CHECK (recording_retention_days BETWEEN 1 AND 3650);
ALTER TABLE tenants ADD COLUMN recording_notice_text text NOT NULL
  DEFAULT 'Görüşmeniz, hizmet kalitemizi artırmak amacıyla kayıt altına alınmaktadır.'
  CHECK (length(recording_notice_text) BETWEEN 1 AND 500);

-- Asterisk kuyruk olayları (app_queue queue_log). Asterisk buraya doğrudan yazar (res_config_pgsql).
-- Zaman UTC'dir. Olaylar ve alanlar: https://docs.asterisk.org/ "Queue Logs".
-- Santralio'nun kendi olayları SANTRALIO_ ile başlar (dialplan'deki QueueLog çağrıları).
CREATE TABLE queue_log (
  id         bigserial PRIMARY KEY,
  time       timestamp NOT NULL,
  callid     text NOT NULL DEFAULT '',
  queuename  text NOT NULL DEFAULT '',
  agent      text NOT NULL DEFAULT '',
  event      text NOT NULL DEFAULT '',
  data1      text NOT NULL DEFAULT '',
  data2      text NOT NULL DEFAULT '',
  data3      text NOT NULL DEFAULT '',
  data4      text NOT NULL DEFAULT '',
  data5      text NOT NULL DEFAULT ''
);
CREATE INDEX queue_log_queue_time ON queue_log (queuename, time);
CREATE INDEX queue_log_callid ON queue_log (callid);

-- Asterisk'in veritabanı rolü (yerel kullanıcı eşlemesi, şifresiz; control/install.sh oluşturur):
-- yalnızca queue_log'a satır ekler. Başka hiçbir tabloyu okuyamaz; gizli alanlara erişimi yoktur.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM asterisk;
GRANT INSERT ON queue_log TO asterisk;
GRANT USAGE ON SEQUENCE queue_log_id_seq TO asterisk;
