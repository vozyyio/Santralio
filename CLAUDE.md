# Santralio: proje rehberi

Bu dosya Claude Code, Cursor ve repoda çalışan herkes için ortak bağlamdır. Her oturumun başında okunur.
Ürün çerçevesi `README.md`'de, mimari `docs/architecture.md`'de, ödeme modülü `docs/payments-module.md`'dedir.

## 1. Ürün

Santralio, yapay zekâ destekli, çok kiracılı (SaaS) santral ve çağrı merkezi yazılımıdır.
Hedef müşteri: firmalar (otel, araç kiralama, klinik, seyahat acentası ve benzerleri). İlk dil Türkçe.

Rakiplerden (ör. Netsipp) ayrılma ilkesi: "santrali izle" yerine **"ne oldu, ne yapılmalı"**.
Yapay zekâ ayrı bir modül değil, her çağrının parçasıdır (karşılama, özet, konu, takip).

Satış, lisans ve fiyat **Vozyy**'dedir. Santralio, Vozyy'nin bastığı lisansla kiracıyı çalıştırır.
Henüz gerçek kullanıcı yok; öncelik arka ucu eksiksiz ve farklılaştırıcı özelliklerle tamamlamak.

## 2. Altyapı

| Parça | Değer |
| --- | --- |
| Sunucu | Hetzner, Ubuntu 26.04, aarch64, 4 GB RAM, `116.203.184.30` |
| Alan adları | `santralio.site` (tanıtım sitesi), `panel.` `crm.` `agent.` (uygulama), `api.` (dış servis bildirimleri), `sip.` (SIP, Cloudflare proxy'siz) |
| Cloudflare | DNS + proxy (sip hariç), Full (strict) SSL |
| Santral | Asterisk 22, PJSIP, app_queue; ses: Piper (yerel TTS), Azure Speech (STT), Claude (yanıt/özet) |
| Kontrol servisi | Node 22 + TypeScript (`control/`), PostgreSQL |
| Panel | React + Vite (`web/`): panel, crm ve agent tek uygulama, alan adına göre ekran |
| Site | Statik, derlenmiş Tailwind (`site/`); bakım modu: `sudo infra/maintenance.sh true|false` |
| Ön uç sunucu | Caddy (`infra/caddy/Caddyfile`) |

## 3. Repo yapısı

```
control/            kontrol servisi (API, CLI, migration'lar, testler)
  migrations/       NNN_ad.sql (sırayla, geri alınmaz)
  src/payments/     ödeme modülü
  src/ai/           yapay zekâ (STT/TTS/LLM adaptörleri)
web/src/            panel (React)
site/src/           tanıtım sitesi, KVKK ve kullanım koşulları taslakları
infra/              kurulum ve yayın betikleri, Caddy, Asterisk, fail2ban
docs/               mimari ve modül belgeleri
```

## 4. Çalışma kuralları

- **Dil:** Kod yorumları, kullanıcıya görünen metinler ve commit mesajları Türkçe. Arayüzde teknik terim yok ("Registered" değil "Bağlı", "rrmemory" değil "Sırayla dağıt").
- **Dal:** Her iş ayrı dalda. Merge ve deploy yalnızca Mustafa'nın onayıyla.
- **Migration:** Yeni dosya `control/migrations/NNN_ad.sql`; mevcut migration değiştirilmez.
- **Gizli bilgi:** Repoya ve sohbete girmez. Sunucuda `sudo infra/set-secret.sh <ad>` ile girilir (değer komut satırına yazılmaz; script sorar). Karşılaştırma için `sudo infra/secret-fingerprint.sh <ad>`.
- **Test:** Her değişiklik testli. Arayüz değişikliği hem **boş/az veriyle** hem dolu veriyle, en az 1440 / 1280 / 390 genişlikte denenir; sayfa yana taşmamalı.
- **Tasarım:** Varsayılan açık tema, isteğe bağlı yumuşak koyu tema; menü üstte, içerik tam genişlik. Renkler yalnızca `web/src/styles.css` içindeki tema değişkenlerinden.
- **Harici script/CDN yok:** Fontlar ve ikonlar pakette; Tailwind derlenmiş.

## 5. Komutlar

```bash
# Kontrol servisi
cd control && npm ci && npm run check && npm test
SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/*.test.ts
# Test veritabanı ilk kez: postgres'te test kullanıcısı ve `asterisk` rolü (createuser asterisk) olmalı

# Panel ve site
cd web && npm ci && npm run build
cd site && npm ci && npm run build

# Sunucuda yayın (onaydan sonra)
sudo control/install.sh       # API, migration, servisler
sudo infra/web-deploy.sh      # panel + Caddy
sudo infra/site-deploy.sh     # tanıtım sitesi
```

## 6. Güvenlik ilkeleri (değişmez)

1. **Kart bilgisi Santralio'ya uğramaz.** Ödeme yalnızca sağlayıcının barındırdığı sayfada (ödeme bağlantısı / ortak ödeme sayfası / 3D hosting) alınır. Tuşlamayla ödeme yalnızca sağlayıcının güvenli tuşlama hizmetiyle ve işletmenin MOTO onayıyla açılır; o bölümde kayıt durur, tuşlar maskelenir, yapay zekâya/transkripte/loga girmez.
2. **Tutar sunucuda belirlenir.** İstemciden gelen tutara güvenilmez; yapay zekâ ve IVR tutar belirleyemez.
3. **"Ödendi" yalnızca doğrulanmış bildirim** (imza/hash) ya da sağlayıcıya sunucudan yapılan durum sorgusuyla yazılır. Aynı bildirim iki kez işlenmez.
4. **Kimlik bilgileri şifreli** (AES-256-GCM, systemd credential anahtarı); API yanıtında asla dönmez.
5. **Yapay zekâ servisi ana anahtar taşımaz.** Rezervasyon işlemleri iç uçtan (`/api/internal/booking`, ortak `santralio-internal-key`, yalnızca localhost, Caddy'de kapalı) API sürecinde yapılır. Model fiyat/tutar belirleyemez; sistem sonuçları tek kullanımlık etiketle (`<sonuc id>`) verilir.
6. **Dış adrese istek** (işletme sistemi sorgusu, webhook) yalnızca genel https adrese; iç ağ/özel IP engellenir (SSRF). Ortak kod `control/src/netguard.ts`: kayıtta DNS denetimi, gönderimde bağlantının kendi DNS çözümlemesinde tekrar denetim, yönlendirme izlenmez.
7. **Kiracı izolasyonu:** her sorgu `tenant_id` ile; yetki `tenantFor(ctx, prefix, izin)` ile.
8. **KVKK:** arayan verilerinin veri sorumlusu kiracı firmadır, Santralio veri işleyendir. Yurt dışı servisler (Azure, Anthropic, Cloudflare) aydınlatma metninde listelenir.

## 7. Vozyy entegrasyonu

- Lisans sözleşmesi: Vozyy → `POST https://api.santralio.site/api/vozyy/events` (HMAC-SHA256, 5 dk zaman penceresi, `event_id` ile tekrar engeli).
- Vozyy API tabanı: `https://api.vozyy.com/license` (ör. `/license/api/santralio/licenses/{id}`).
- Başvuru ve ödeme santralio.site'de; müşteri vozyy.com'a gitmez. `PushEnabled` ancak anahtar parmak izleri eşleşip uçtan uca test geçince açılır.
- Kiracı öneki `t` + sayı (ör. `t12`); müşterinin istediği kısa ad ayrı `slug` alanındadır.

## 8. Durum (son güncelleme: 2026-11-15)

| Alan | Durum |
| --- | --- |
| Santral (gelen arama, kuyruk, menü, çalışma saatleri, dahili, kayıt) | Var |
| Yapay zekâ karşılama, çok dilli; CRM; dış arama; raporlar; roller | Var |
| Vozyy lisans olayları ucu | Yayında; push kapalı, uçtan uca test bekliyor |
| Panel yeni tasarım (Operasyon konsolu, üst menü, açık tema) | Var |
| Ödeme modülü: PayTR, iyzico, test sağlayıcı, Netgsm SMS, profiller, panel, temsilci "Ödeme iste" | Var; gerçek sağlayıcı hesaplarıyla test edilmedi |
| Kaçan çağrıya otomatik yapay zekâ geri araması (`control/src/callbacks.ts`, Panel → Kaçan çağrılar) | Var; dialplan Asterisk 20'de doğrulandı, gerçek hatla test edilmedi |
| Webhook (`control/src/webhooks.ts`, Panel → Entegrasyonlar): 11 olay, HMAC imza, outbox + yeniden deneme, otomatik kapanma | Var; birim ve veritabanı testleri geçti |
| Arayanı tanıma (`crm.callerHistory`): yapay zekâ talimatına kart/kaçıncı arama/son özet; karşılamada `{ad}`; temsilci ekranında "N. araması" | Var; yapay zekâ akışında açılıp kapanır (varsayılan açık) |
| "Sıranız gelince sizi arayalım" (`control/src/queuecb.ts`, Panel → Kuyruklar) | Var; dialplan Asterisk 20.6'da Local kanalla çalıştırıldı, gerçek hatla test edilmedi |
| Görüşme sonrası yapay zekâ analizi (`control/src/analysis.ts`, `ai/analyzer.ts`; Panel → Yapay zekâ, CRM → Yapay zekâ) | Var; varsayılan kapalı, gerçek API ile test edilmedi |
| Santral/yapay zekâ ödeme adımı (`payment:<profil>`, `control/src/payments/ivr.ts`) | Var; dialplan Asterisk 20.6'da çalıştırıldı; gerçek sağlayıcı ve SMS ile test edilmedi; tuşlama yok |
| Haftalık yapay zekâ raporu (`analysis.runWeekly`) | Var; varsayılan kapalı, gerçek API ile test edilmedi |
| Otomatik şifreli yedek (`infra/backup.sh`, restic, her gece 02:15 UTC) | Var; sunucuda `init` bekliyor |
| Canlı durum ve TV ekranı (`control/src/live.ts`, Panel → Canlı, `#/tv/<önek>`) | Var; çıktılar Asterisk 20.6'da doğrulandı |
| Yapay zekâ ile rezervasyon (`booking.ts`, `bookingexec.ts`, `ai/assistant.ts`; Panel → Rezervasyon, CRM → Rezervasyonlar) | Var; yerleşik mod ve işletme sistemi sözleşmesi (`docs/booking-contract.md`); gerçek aramayla test edilmedi |
| Web sitesi sohbeti (`chat.ts`, `control/chat/`; Panel → Web sohbeti) | Var; sahte modelle uçtan uca, gerçek API ile test edilmedi |
| API anahtarları (`apikeys.ts`, `docs/api.md`; Panel → Entegrasyon) ve kurulum adımları (`setup.ts`, Özet) | Var |
| Panelden kurulum: operatör hattı, numara, kuyruk, menü, çalışma saati | Var; gerçek hatla test edilmedi |
| Tanıtım sitesi | Bakımda; KVKK ve koşullar taslak (hukuk kontrolü bekliyor) |

## 9. Yol haritası (öncelik sırası)

1. **Gerçek ortam testleri:** test planı (Docs: "Santralio — Kalan İşler ve Test Planı") sırayla; rezervasyon, sohbet, ödeme, geri aramalar gerçek hat ve anahtarlarla.
2. **Octopus entegrasyonu** (beklemede): Octopus rezervasyon sözleşmesini (`docs/booking-contract.md`) doğrudan uygular; otomasyonu olmayan işletmeye Octopus, olana entegrasyon.
3. **Tuşlayarak ödeme:** sağlayıcının güvenli tuşlama hizmeti (ilk aday: hangi sağlayıcı sunuyorsa) + MOTO; ödeme adımına "2" seçeneği.
4. Kurulum sihirbazında işletme belgelerinden (fiyat listesi, SSS, web sitesi) yapay zekâ akışı talimatı ve konu listesi üretme.
5. Temsilci görüşmelerinin (kayıt) yazıya dökülüp analiz edilmesi (Azure toplu yazıya dökme). Kuyrukta geri aranma, kaçan çağrıya geri arama, arayanı tanıma ve yapay zekâ görüşme analizi tamamlandı.
6. Rezervasyon hatırlatma araması ve kapora (rezervasyon altyapısı hazır).
   - Gelmeme riskine göre kapora isteme (ödeme modülüyle). Risk puanı somut geçmişten (önceki gelmeme, ilk kez mi, ne kadar önceden); ses tonu yalnızca destekleyici sinyal (KVKK: profilleme, aydınlatma metninde yer almalı).
   - Çok dilli sağlık/turizm yönlendirmesi: kiracı bazlı terim sözlüğü (STT kelime listesi), niyete göre kuyruk. Sağlık soruları özel nitelikli veri: önce açık rıza, "değerlendirme" değil "bilgi toplama".
7. KVKK maskeleme; giden yapay zekâ aramaları (acenteler için kampanya/teyit).
8. Bayiler için beyaz etiket, mobil uygulama altyapısı.
9. Kanallar: WhatsApp araması, web sitesi arama butonu.

## 10. Ödeme: Vozyy ödeme merkezi kararı (beklemede)

Vozyy'de 10 ödeme kuruluşu + 20 banka bağlantısı var (`IPaymentProviderClient`). Santralio'nun bu bağlantıları kullanması için **önce Vozyy tarafında** şunlar düzeltilmeli:

- Kart numarası ve CVC Vozyy sunucusundan geçiyor (PCI DSS kapsamı); NestPay `3d_pay` → `3d_pay_hosting`, iyzico/Craftgate → Checkout Form, barındırılan sayfalı sağlayıcılarda widget kart istememeli.
- Moka ve Param bildirimleri imzasız; tutar istemciden geliyor; widget ucunda origin/hız sınırı yok; şifreleme anahtarı yer tutucusu repoda.

Bunlar düzeltildikten sonra plan: Vozyy'de **ödeme oturumu API'si** (tutar + açıklama + POS bağlantısı → sağlayıcının güvenli sayfası; ödenince imzalı olay). Santralio'ya bunu kullanan tek bir `vozyy` sağlayıcısı eklenir; mevcut PayTR/iyzico bağlantıları yedek kalır.

## 11. Açık kararlar

- İlk banka bağlantısı: NestPay (3D Pay Hosting) önerildi.
- Fiyatlar, deneme süresi, ödeme alınamazsa ek süre, iptal sonrası veri saklama süresi.
- Tuşlamayla ödeme için PCI DSS: sağlayıcının güvenli tuşlama hizmeti mi, kendi altyapı mı.
- Repo görünürlüğü (şu an herkese açık).
- Geçici sudo izni kaldırılmalı: `sudo rm /etc/sudoers.d/90-santralio-setup`.
