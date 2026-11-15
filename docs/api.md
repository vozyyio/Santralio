# Santralio API (işletmeler için)

İşletmenin kendi yazılımı (otel / acente / rent-a-car / CRM) Santralio'yu API anahtarıyla çağırır.
Anahtar: Panel → Entegrasyon → API anahtarları. Yalnızca oluşturulurken bir kez gösterilir.

```
GET https://api.santralio.site/api/tenants/<önek>/bookings?status=pending
Authorization: Bearer sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- `<önek>`: firmanın Santralio kodu (ör. `t12`); `GET /api/me` ile de görülür.
- Anahtar yalnızca seçilen yetkilerle çalışır; ayar, personel ve ödeme ayarı değiştiremez. Başka firmanın verisi `404` döner.
- Dakikada en fazla 300 istek (`429`). Hata yanıtı: `{ "error": "…" }`.
- Olay bildirimi (anlık) için webhook kullanın: Panel → Entegrasyon → Webhook.

## Uçlar

| Yetki | İstek | Açıklama |
|---|---|---|
| — | `GET /api/me` | Anahtarın adı, yetkileri |
| `calls.all` | `GET /api/tenants/<önek>/calls?from=2026-11-01&to=2026-11-15&limit=500` | Görüşmeler (arayan, kuyruk, temsilci, süre, sonuç, not) |
| `reports.view` | `GET /api/tenants/<önek>/reports/summary?from=…&to=…` | Özet rapor |
| `reports.view` | `GET /api/tenants/<önek>/live` | Canlı durum (bekleyen, süren, temsilciler) |
| `crm.use` | `GET /api/tenants/<önek>/lookup?phone=05321112233` | Numaraya göre müşteri kartı ve son notlar |
| `crm.use` | `GET /api/tenants/<önek>/contacts?q=ayşe` | Müşteri arama |
| `crm.use` | `POST /api/tenants/<önek>/contacts` | Kart oluştur `{ "name", "company", "email", "phones": ["+905…"], "tags": [] }` |
| `crm.use` | `PUT /api/tenants/<önek>/contacts/<id>` | Kart güncelle (aynı gövde) |
| `bookings.manage` | `GET /api/tenants/<önek>/bookings?status=pending\|confirmed\|cancelled` | Santralio'dan gelen rezervasyonlar |
| `bookings.manage` | `POST /api/tenants/<önek>/bookings/<id>/confirm` | Onayla (`booking.confirmed` webhook'u gider) |
| `bookings.manage` | `POST /api/tenants/<önek>/bookings/<id>/cancel` | İptal `{ "note": "…" }` |
| `payments.request` | `POST /api/tenants/<önek>/payments/requests` | Ödeme bağlantısı oluştur ve SMS gönder (aşağıda) |
| `payments.request` | `GET /api/tenants/<önek>/payments/requests/<pay_…>` | Ödeme durumu |

### Ödeme bağlantısı

```json
POST /api/tenants/t12/payments/requests
{ "amount": "1500.00", "description": "Kapora - 12-15 Aralık", "phone": "+905321112233", "sendSms": true }
```
ya da tanımlı bir profille: `{ "profile": "kapora", "phone": "+905321112233" }`. Yanıtta `id` (pay_…), `linkUrl`, `status`, `smsStatus`.
Ödeme sonucu `payment.paid` webhook'uyla bildirilir.

## Rezervasyon bağlantısı

Santralio'nun sizin sisteminize sorması (müsaitlik, fiyat, kayıt) ayrı bir sözleşmedir: `docs/booking-contract.md`.
