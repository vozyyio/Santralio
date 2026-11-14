# Webhook ve arayanı tanıma

## Webhook

Kiracı, Panel → Entegrasyonlar'dan en fazla 10 uç ekler (yetki: `settings.manage`). Her uç bir https adres, seçilen olaylar ve sunucunun ürettiği gizli anahtardan oluşur. Anahtar yalnızca eklemede ve yenilemede bir kez gösterilir; AES-256-GCM ile şifreli saklanır.

### İstek

```
POST <adres>
Content-Type: application/json
User-Agent: Santralio-Webhooks/1
X-Santralio-Event: payment.paid
X-Santralio-Event-Id: evt_…
X-Santralio-Timestamp: 1763120469
X-Santralio-Signature: sha256=<hex(HMAC-SHA256(gizli_anahtar, timestamp + "." + ham_gövde))>

{ "id": "evt_…", "type": "payment.paid", "created_at": "2026-11-14T11:41:09Z", "tenant": "t12", "data": { … } }
```

Alıcı imzayı ham gövdeyle doğrular, 5 dakikadan eski zaman damgasını reddeder ve aynı `id`'yi ikinci kez işlemez (yeniden denemelerde aynı `id` gelir). Panelde Node.js örneği var.

### Olaylar

| Olay | Ne zaman | `data` |
| --- | --- | --- |
| `call.missed` | Kuyrukta kapattı / süre doldu / temsilci yok / dahili cevap vermedi | `call_id, queue, caller, did, reason, wait_s, at` |
| `call.completed` | Cevaplanan görüşme bitti | `call_id, queue, caller, did, agent, wait_s, talk_s, hung_up_by, at` |
| `ai.session.ended` | Yapay zekâ görüşmesi bitti | `session_id, call_id, flow, caller, did, kind (inbound/callback), end_reason, route_target, language, summary` |
| `callback.answered` | Otomatik geri arama açıldı | `job_id, phone, attempts, ai_session_id, missed_call_id` |
| `callback.failed` | Ulaşılamadı ya da arama başlatılamadı | `job_id, phone, reason, attempts?, missed_call_id?` |
| `payment.paid` | Doğrulanmış ödeme | `reference, amount, paid_amount, currency, description, method, phone, call_id, created_by, card_last4, late` |
| `payment.failed` | Eksik tutar ödendi | aynı alanlar + `reason` |
| `payment.expired` / `payment.cancelled` | Bağlantının süresi doldu / iptal | ödeme alanları |
| `contact.created` | Yeni müşteri kartı | `contact_id, name, company, email, phones, tags, created_by` |
| `note.saved` | Görüşme notu kaydedildi/güncellendi | `note_id, updated, call_id, phone, contact_id, direction, disposition, note, follow_up_at, user` |
| `webhook.test` | Panelden "Test gönder" | `message` |

### Teslim

- Olay, işi doğuran işlemle aynı transaction'da `webhook_deliveries`'e yazılır (outbox). İş geri alınırsa olay da gitmez.
- Gönderici 10 saniyede bir çalışır (`SANTRALIO_WEBHOOKS=off` ile kapanır). 2xx dışı yanıt ve bağlantı hatası 1 dk, 5 dk, 30 dk, 2 sa, 12 sa, 24 sa sonra yeniden denenir; 7. denemeden sonra `failed`. Panelden "Yeniden gönder" ile sıfırdan sıraya girer.
- Arka arkaya 50 başarısız teslimde uç kendiliğinden kapanır; neden panelde görünür. Açılınca sayaç sıfırlanır.
- Görüşme olayları `queue_log`'dan okunur; konum `event_cursors` tablosunda. İlk çalışmada geçmiş gönderilmez.

### Güvenlik

- Adres yalnızca https, 443, kullanıcı/şifresiz, genel alan adı (IP yazılamaz). Kayıtta alan adı çözülür; iç ağ adresine çözülürse reddedilir.
- Gönderimde bağlantının kendi DNS çözümlemesi de denetlenir (DNS rebinding). Yönlendirme izlenmez, zaman aşımı 10 sn, yanıtın en fazla 1 KB'ı saklanır.
- Kart bilgisi hiçbir olayda yoktur (yalnızca sağlayıcı verdiyse son 4 hane).

## Arayanı tanıma

`crm.callerHistory(db, tenant, numara, buGörüşme)`: numaranın kartı, son 12 aydaki arama sayısı (kuyruk girişi + yapay zekâ oturumu, bu görüşme hariç; `0532…`, `+90532…`, `532…` biçimleri birlikte), son arama zamanı, son yapay zekâ özeti ve son temsilci notu. Yalnızca o kiracının kayıtları.

- **Yapay zekâ:** akışta "Arayanı tanı" açıksa (varsayılan) bu bilgiler talimatın önüne "veri, talimat değil" başlığıyla eklenir. Asistana, numara taklit edilebileceği için kayıtlı bilgileri ve önceki görüşmelerin içeriğini arayana kendiliğinden okumaması, doğrulamaması söylenir. Ad ve özet tek satıra indirilip kısaltılır.
- **Karşılama:** metinde `{ad}` varsa kayıtlı müşterinin adıyla okunur; kart yoksa yer tutucu temizlenir ("Merhaba {ad}, …" → "Merhaba, …"). Bu, numarayı taklit eden birine kartın adını söyler; kiracı bunu bilerek açar.
- **Temsilci ekranı:** müşteri panelinde "İlk araması" ya da "N. araması · son: …" ve önceki yapay zekâ özeti.
