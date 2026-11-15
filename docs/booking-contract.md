# Santralio rezervasyon sözleşmesi

Santralio'nun yapay zekâ asistanı (telefonda ve web sohbetinde) rezervasyon alırken işletmenin kendi sistemine
(otomasyon, PMS, rent-a-car, transfer yazılımı) bu sözleşmeyle sorar. Panel → Rezervasyon → "Kendi sistemime bağla".

Sistemi olmayan işletme "Santralio'da tut" modunu seçer: rezervasyonlar CRM → Rezervasyonlar'da tutulur, ekip onaylar.

## Temel kurallar

- Asistan fiyatı ve müsaitliği **kendisi söyleyemez**; yalnızca sizin `quote` yanıtınızı okur.
- Asistan, arayana bilgileri özetleyip onay almadan `create` göndermez. Onaylanan bilgiler fiyatı sorulan bilgilerle
  birebir aynı olmak zorundadır (Santralio kodda da denetler). Görüşme başına en fazla 4 `quote` ve 1 `create`.
- Ödeme gerekiyorsa tutar sizin `create` yanıtınızdaki `price`'tan alınır; ödeme bağlantısını Santralio, işletmenin
  bağladığı ödeme kuruluşundan oluşturup arayanın cep telefonuna SMS ile gönderir. Kart bilgisi Santralio'ya gelmez.
- Arayan numarası taklit edilebilir. `lookup` yanıtına kişisel bilgi (TC, adres, kart, e-posta) koymayın; kısa özet yeter.

## İstek

`POST <adresiniz>` — gövde JSON, en fazla 6 saniyede yanıt bekler. Başlıklar:

| Başlık | Değer |
|---|---|
| `Content-Type` | `application/json` |
| `X-Santralio-Timestamp` | Unix saniye |
| `X-Santralio-Signature` | `sha256=` + hex(HMAC-SHA256(gizli anahtar, zaman + "." + ham gövde)) |
| `X-Santralio-Action` | `quote` / `create` / `lookup` / `cancel` |

Gizli anahtar (`bksec_…`) bağlantıyı ilk kaydettiğinizde **bir kez** gösterilir. İmzayı ham gövde üzerinde doğrulayın,
5 dakikadan eski zaman damgasını reddedin. Webhook doğrulamasıyla aynıdır (Panel → Entegrasyonlar'daki örnek kod).

`fields` her zaman paneldeki hizmet tanımına göre denetlenmiş gelir: zorunlu alanlar dolu, tarih `YYYY-MM-DD`,
saat `HH:MM`, tarih-saat `YYYY-MM-DD HH:MM`, sayı tam sayı, seçenek tanımdaki yazımıyla.

### quote — müsaitlik ve fiyat

```json
{ "action": "quote", "service": "transfer", "phone": "+905321112233",
  "fields": { "yon": "Havalimanından otele", "tarih": "2026-12-01", "saat": "14:30", "kisi_sayisi": "3" } }
```
Yanıt:
```json
{ "available": true, "price": { "amount": "85.00", "currency": "EUR" }, "message": "Son 2 araç" }
```
`price` yoksa `null` (asistan "ekibimiz teyit edecek" der). `message` asistana not olarak okunur (en fazla 300 karakter,
arayana aynen okunması gerekmez). Para birimi: TRY, EUR, USD, GBP.

### create — rezervasyon oluştur

```json
{ "action": "create", "service": "transfer", "fields": { … }, "phone": "+905321112233",
  "customer_name": "Ayşe Yılmaz", "call_id": "1763120000.42", "santralio_reference": "RZ7KQ2M9XA" }
```
Yanıt:
```json
{ "reference": "TRF-9981", "status": "confirmed", "price": { "amount": "85.00", "currency": "EUR" }, "payment": "optional" }
```
- `reference` zorunlu (arayana harf harf okunur, kısa tutun).
- `status`: `confirmed` ya da `pending` (ekip teyit edecek).
- `payment`: `none` / `optional` (arayan isterse) / `required`. Yazılmazsa paneldeki hizmet ayarı geçerlidir.
- Aynı `santralio_reference` ile ikinci istek gelirse aynı rezervasyonu döndürün (zaman aşımında yeniden deneme olabilir).

### lookup — arayanın rezervasyonları

```json
{ "action": "lookup", "phone": "+905321112233" }
```
Yanıt (en fazla 5):
```json
{ "bookings": [ { "reference": "TRF-9981", "service": "Transfer", "summary": "3 kişi, Vito", "date": "2026-12-01", "status": "confirmed" } ] }
```
Panelde "Bağlantıyı test et" `{"action":"lookup","phone":"+900000000000","test":true}` gönderir; boş liste dönmeniz yeterli.

### cancel — panelden iptal

```json
{ "action": "cancel", "reference": "TRF-9981", "phone": "+905321112233" }
```
Yanıt: `{ "ok": true, "message": null }`

## Hatalar

2xx dışı yanıt, geçersiz JSON ya da 6 saniye aşımında asistan arayandan özür diler ve temsilciye aktarır.
Adres https olmalı ve internetten erişilebilmeli (iç ağ adreslerine istek gönderilmez).

## Olaylar

Santralio üzerinden oluşan her rezervasyon webhook olarak da bildirilir: `booking.created`, `booking.confirmed`,
`booking.cancelled` (Panel → Entegrasyonlar).
