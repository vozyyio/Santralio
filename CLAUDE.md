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
SANTRALIO_TEST_DB=santralio_test SANTRALIO_PG_DATABASE=santralio_test node --test tests/vozyy.test.ts tests/payments.test.ts

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
5. **Dış adrese istek** (işletme sistemi sorgusu vb.) yalnızca genel https adrese; iç ağ/özel IP engellenir (SSRF).
6. **Kiracı izolasyonu:** her sorgu `tenant_id` ile; yetki `tenantFor(ctx, prefix, izin)` ile.
7. **KVKK:** arayan verilerinin veri sorumlusu kiracı firmadır, Santralio veri işleyendir. Yurt dışı servisler (Azure, Anthropic, Cloudflare) aydınlatma metninde listelenir.

## 7. Vozyy entegrasyonu

- Lisans sözleşmesi: Vozyy → `POST https://api.santralio.site/api/vozyy/events` (HMAC-SHA256, 5 dk zaman penceresi, `event_id` ile tekrar engeli).
- Vozyy API tabanı: `https://api.vozyy.com/license` (ör. `/license/api/santralio/licenses/{id}`).
- Başvuru ve ödeme santralio.site'de; müşteri vozyy.com'a gitmez. `PushEnabled` ancak anahtar parmak izleri eşleşip uçtan uca test geçince açılır.
- Kiracı öneki `t` + sayı (ör. `t12`); müşterinin istediği kısa ad ayrı `slug` alanındadır.

## 8. Durum (son güncelleme: 2026-11-13)

| Alan | Durum |
| --- | --- |
| Santral (gelen arama, kuyruk, menü, çalışma saatleri, dahili, kayıt) | Var |
| Yapay zekâ karşılama, çok dilli; CRM; dış arama; raporlar; roller | Var |
| Vozyy lisans olayları ucu | Yayında; push kapalı, uçtan uca test bekliyor |
| Panel yeni tasarım (Operasyon konsolu, üst menü, açık tema) | Var |
| Ödeme modülü: PayTR, iyzico, test sağlayıcı, Netgsm SMS, profiller, panel, temsilci "Ödeme iste" | Var; gerçek sağlayıcı hesaplarıyla test edilmedi |
| Kaçan çağrıya otomatik yapay zekâ geri araması (`control/src/callbacks.ts`, Panel → Kaçan çağrılar) | Var; dialplan Asterisk 20'de doğrulandı, gerçek hatla test edilmedi |
| Tanıtım sitesi | Bakımda; KVKK ve koşullar taslak (hukuk kontrolü bekliyor) |

## 9. Yol haritası (öncelik sırası)

1. **Canlı durum ucu:** bekleyen çağrı, aktif görüşme, temsilci durumu (AMI/ARI, olay akışı). Gerçek santralde test edilir.
2. **Ödeme: sesli menü ve yapay zekâ adımı.** Arayana "SMS ile bağlantı 1, tuşlama 2" sorusu; yapay zekânın sesli onayla bağlantı göndermesi. Akışta yeni hedef türü `payment:<profil>`.
3. **Görüşme sonrası yapay zekâ analizi:** özet, konu, hava, takip işi, "yapay zekâ çözdü mü".
4. **Arayanı tanıma** (CRM eşleşmesi, kaçıncı arama) ve **"sıranız gelince sizi arayalım"** (kuyrukta beklemek yerine geri aranma). Kaçan çağrıya otomatik geri arama tamamlandı.
5. Randevu/rezervasyonu konuşmadan oluşturma (takvim, otel sistemi), otomatik hatırlatma araması.
   - Gelmeme riskine göre kapora isteme (ödeme modülüyle). Risk puanı somut geçmişten (önceki gelmeme, ilk kez mi, ne kadar önceden); ses tonu yalnızca destekleyici sinyal (KVKK: profilleme, aydınlatma metninde yer almalı).
   - Çok dilli sağlık/turizm yönlendirmesi: kiracı bazlı terim sözlüğü (STT kelime listesi), niyete göre kuyruk. Sağlık soruları özel nitelikli veri: önce açık rıza, "değerlendirme" değil "bilgi toplama".
6. Webhook ve açık API, TV ekranı, anlık uyarılar, haftalık yapay zekâ raporu, KVKK maskeleme.
7. Bayiler için beyaz etiket, kurulum sihirbazı, mobil uygulama altyapısı.
8. Kanallar: WhatsApp araması, web sitesi arama butonu.

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
