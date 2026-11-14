-- Santralio: "Sıranız gelince sizi arayalım" (kuyrukta beklemek yerine geri aranma).
--
-- Kuyrukta belli bir süre bekleyen arayana duyuru çalınır: "Sıranızı kaybetmeden geri aranmak için 1'e basın."
-- 1'e basan kuyruktan çıkar, dialplan SANTRALIO_QCB_REQUEST olayını queue_log'a yazar ve kapatır.
-- Kontrol servisi bu olaydan iş açar. Arayanın sırası geldiğinde (temsilci boş ve kuyrukta ondan önce girmiş
-- kimse beklemiyorsa) kiracının hattından arar; açınca öncelikli olarak aynı kuyruğa alınır.

ALTER TABLE queues
  ADD COLUMN cb_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN cb_offer_after_s integer NOT NULL DEFAULT 60 CHECK (cb_offer_after_s BETWEEN 20 AND 600),
  ADD COLUMN cb_expire_min    integer NOT NULL DEFAULT 120 CHECK (cb_expire_min BETWEEN 10 AND 720),
  ADD COLUMN cb_offer_text    text NOT NULL DEFAULT 'Sıranızı kaybetmeden sizi geri aramamızı isterseniz 1''e basın.'
                              CHECK (length(cb_offer_text) BETWEEN 1 AND 300),
  ADD COLUMN cb_confirm_text  text NOT NULL DEFAULT 'Talebiniz alındı. Sıranız geldiğinde sizi bu numaradan arayacağız. İyi günler.'
                              CHECK (length(cb_confirm_text) BETWEEN 1 AND 300),
  ADD COLUMN cb_connect_text  text NOT NULL DEFAULT 'Merhaba, geri arama talebiniz için arıyoruz. Sizi şimdi temsilcimize bağlıyoruz.'
                              CHECK (length(cb_connect_text) BETWEEN 1 AND 300),
  ADD COLUMN cb_nonum_text    text NOT NULL DEFAULT 'Numaranız görünmediği için sizi geri arayamıyoruz. Bekleme sırasına geri alındınız.'
                              CHECK (length(cb_nonum_text) BETWEEN 1 AND 300);

CREATE TABLE queue_callbacks (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id),
  queue_id        integer NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  source_callid   text NOT NULL,
  phone           text NOT NULL,           -- arayan numarası (E.164 ya da gelen ham değer)
  entered_at      timestamptz NOT NULL,    -- kuyruğa ilk giriş: sıra buna göre
  requested_at    timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'dialing', 'connected', 'no_answer', 'expired', 'cancelled', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_at         timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  connected_at    timestamptz,
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_callid)
);
CREATE INDEX queue_callbacks_open ON queue_callbacks (tenant_id, queue_id, entered_at) WHERE status IN ('waiting', 'dialing');
