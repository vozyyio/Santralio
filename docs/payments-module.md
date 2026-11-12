# Ödeme modülü (`payments`)

İşletme, kendi müşterisinden görüşme sırasında ödeme alır. Santralio teknik aracıdır:
**para ve kart bilgisi Santralio'ya uğramaz.** İşletme kendi bankasını / ödeme kuruluşunu bağlar.

## Durum

| Parça | Durum |
| --- | --- |
| Sağlayıcı kataloğu, bağlama, şifreli kimlik bilgisi, bağlantı testi | Hazır |
| PayTR Link API (bağlantı, PayTR SMS'i, imzalı bildirim, iptal) | Hazır — gerçek PayTR hesabıyla test edilmeli |
| iyzico Link (stoklu tek kullanımlık bağlantı, durum sorgusu) | Hazır — iyzico sandbox ile test edilmeli |
| Santralio test sağlayıcısı (para hareketsiz uçtan uca deneme) | Hazır |
| Netgsm SMS (REST v2) | Hazır — gerçek hesapla test edilmeli |
| Ödeme profilleri (sabit / temsilci / işletme sisteminden sorgu, üst sınır, taksit, geçerlilik) | Hazır |
| Panel → Ödeme ekranı; Temsilci masasında "Ödeme iste" | Hazır |
| Banka sanal POS'ları (NestPay, Garanti, Posnet, PayFlex, Kuveyt Türk, DenizBank), Param, Paynet, Sipay, Moka, Stripe | Katalogda "yakında" |
| Yapay zekâ ve sesli menü (IVR) adımı, "bağlantı mı tuşlama mı?" sorusu | Sırada |
| Tuşlamayla ödeme (DTMF) | Kapalı: sağlayıcının güvenli tuşlama hizmeti + işletmenin MOTO onayı gerekir |

## Kurallar

- Tutar sunucuda belirlenir: profilin sabit tutarı, işletmenin sistemi (`lookup`, yalnızca genel https adres) ya da yetkili temsilci; her durumda profil üst sınırı. Yapay zekâ ve IVR tutarı kendisi belirleyemez.
- "Ödendi" yalnızca sağlayıcının **imzası doğrulanmış** bildirimiyle ya da sunucudan yapılan durum sorgusuyla yazılır. Aynı bildirim ikinci kez işlenmez. Ödenen tutar talepten azsa "ödendi" yazılmaz.
- Kimlik bilgileri AES-256-GCM ile şifreli; API yanıtlarında hiç dönmez (gizli alanlar yalnızca "girildi").
- Her işlem denetim günlüğüne yazılır (`payments.*`).

## Uçlar

- Panel (oturumlu): `/api/payments/catalog`, `/api/tenants/:p/payments/{settings,providers,sms,profiles,requests}`
- Sağlayıcı bildirimi (genel): `POST https://api.<alan>/api/payments/callback/<32 karakter anahtar>`
- Test ödeme sayfası (genel, yalnızca test sağlayıcısı): `GET|POST https://api.<alan>/api/payments/test-page/pay_…`

## Yetkiler

`payments.manage` (ayarlar, tüm ödemeler) ve `payments.request` (ödeme isteme, kendi talepleri). Lisans modülü: `payments`.
