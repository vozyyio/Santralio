# Santralio mimarisi: çok kiracılı çağrı altyapısı

**Kapsam:** README'deki ilerleme sırasının 2. adımı. Gelen arama bağlanır, kuyruğa girer ve temsilciye düşer.
**Durum:** Öneri. Kurulum yapılmadı. Açık kararlar en sonda listelenir.

Santralio tek bir şirketin santrali değildir. Oteller, rent a car'lar, diş hekimleri ve acentalar gibi pek çok kiracıya hizmet veren bir SaaS'tır. Her kiracı kendi operatöründen (Netgsm, Verimor vb.) kendi SIP hesabını getirir. Bu yüzden hiçbir trunk, numara ya da dahili koda sabit yazılmaz. Hepsi kiracı kaydı olarak veritabanında tutulur. Kiracılar birbirini göremez.

## Bileşenler

```
 Netgsm / Verimor / ...            Temsilci softphone (TLS 5061)
        │  (her kiracının kendi trunk'ı)      │
        ▼                                     ▼
 ┌──────────────── Asterisk 22 (PJSIP + app_queue) ────────────────┐
 │  t1-inbound / t1-internal / t1 kuyrukları  │  t2-... │  t3-...  │
 └───────────▲───────────────────────────────────────────────────┘
             │ oluşturulan konfigürasyon + AMI reload
 ┌───────────┴──────────────┐      ┌──────────────────────────────┐
 │ Santralio kontrol servisi│◄────►│ PostgreSQL (kiracı, trunk,   │
 │ (Node 22 / TypeScript)   │      │ DID, dahili, kuyruk, lisans) │
 └───────────▲──────────────┘      └──────────────────────────────┘
             │ kiracı bazında lisans/yetki
           Vozyy
```

| Bileşen | Görev |
| --- | --- |
| Asterisk 22 | SIP sinyali (PJSIP), ses, kuyruk (`app_queue`), bekleme müziği ve anonslar. Ubuntu paketinden kurulur |
| PostgreSQL | Tek bilgi kaynağı: kiracı, trunk, DID, dahili, kuyruk, lisans, denetim kaydı |
| Kontrol servisi | Veritabanından Asterisk konfigürasyonu üretir, AMI ile yeniden yükler, lisansı uygular. İlk sürümde yönetim işleri CLI ile yapılır |
| Vozyy | Kiracı bazında lisansı basar. Santralio bu lisansı okur |

### Teknoloji seçiminin gerekçesi

- **Asterisk 22:** Ubuntu 26.04 deposunda arm64 için hazır paket var. `app_queue`, PJSIP, ARI ve AMI içinde geliyor. Güvenlik güncellemeleri `unattended-upgrades` ile alınır.
- **FreeSWITCH seçilmedi:** Ubuntu deposunda yok, SignalWire token'ı gerekiyor ve arm64 desteği zayıf.
- **Kamailio şimdilik yok:** Pilot ölçekte gereksiz bir katman olur. Birden fazla Asterisk sunucusuna geçilince öne SBC olarak eklenir.
- **Docker kullanılmıyor:** Geniş RTP port aralığı Docker NAT ile sorun çıkarır, host ağı zaten gerekirdi. Doğrudan kurulum daha sade.

## Konfigürasyon üretimi

Kiracılara ait Asterisk konfigürasyonu elle yazılmaz. Kontrol servisi bu konfigürasyonu veritabanından üretir ve `/etc/asterisk/tenants/<kiracı>/` altına yazar. Dosyalar önce geçici bir dosyaya yazılır, sonra yerine taşınır. Ardından AMI üzerinden `res_pjsip`, dialplan ve kuyruklar yeniden yüklenir.

Asterisk'in veritabanından doğrudan okuma modu (realtime, `res_config_pgsql`) kullanılmaz. Bu mod trunk şifresini veritabanında düz metin olarak okumak ister. Bu da şifrelerin veritabanında şifreli durması şartıyla çelişir.

İleride daha sıkı bir seçenek değerlendirilebilir: nesneleri ARI ile doğrudan Asterisk belleğine yüklemek. Bu durumda diske hiç şifre yazılmaz. Karşılığında, Asterisk her yeniden başladığında kontrol servisinin tüm kiracıları yeniden yüklemesi gerekir.

## Şifreler

- Trunk şifreleri veritabanında AES-256-GCM ile şifreli durur (`secret_enc`). Her kayıtta bir `key_id` tutulur, böylece anahtar yenilenebilir.
- Ana anahtar veritabanında da depoda da durmaz. `systemd-creds` ile şifrelenmiş bir credential olarak yalnızca kontrol servisine verilir.
- İlk sunucuda TPM yok. `systemd-creds` credential'ları sunucunun kendi sır dosyasıyla (`/var/lib/systemd/credential.secret`) şifreler. Bu yöntem veritabanı dökümü ya da yedek sızarsa şifreleri korur, ama sunucuda root yetkisi ele geçirilirse korumaz.
- Sunucu kaybedilirse ana anahtar da kaybolur ve şifreli alanlar açılamaz. Ana anahtarın bir kopyası sunucu dışında, kasada saklanmalıdır.
- Şifre düz metin olarak yalnızca `/etc/asterisk/tenants/<kiracı>/` dosyalarında bulunur. Bu dosyalar `0640 root:asterisk` izinleriyle yazılır.
- Trunk şifresi sohbete, bilet sistemine ya da depoya yazılmaz. Sunucuda CLI'nin sorduğu gizli girişe yazılır ve doğrudan şifrelenip veritabanına kaydedilir.
- Temsilci SIP şifreleri rastgele üretilir ve aynı yöntemle saklanır.

## Kiracı izolasyonu

### Adlandırma

Asterisk'teki her nesnenin adı kiracı önekiyle başlar. Kiracı kendi panelinde yine `1001` görür. İkinci bir kiracı da kendi `1001`'ini açabilir, çakışma olmaz.

| Nesne | Örnek (`t1` kiracısı) |
| --- | --- |
| Dahili (endpoint, aor, auth) | `t1_1001`, `t1_1002` |
| Trunk | `t1_trunk` |
| Kuyruk | `t1_destek` |
| Context | `t1-inbound`, `t1-internal` |
| Bekleme müziği sınıfı | `t1` |

### Dialplan

- Her dahilinin context'i yalnızca kendi kiracısının `tN-internal` context'idir.
- Bu context'ten yalnızca aynı kiracının dahilileri, kuyrukları ve trunk'ı aranabilir.
- Ortak alt rutinler (`Gosub`) kiracıyı arayan kişiden almaz. Değer endpoint'teki `set_var=TENANT=tN` ayarından gelir.
- Kimliği eşleşmeyen her istek reddedilir. Anonim endpoint yoktur, varsayılan context `reject` olur.

### Gelen aramanın doğru kiracıya düşmesi

Birden fazla kiracı aynı operatörü kullandığında aramalar aynı operatör IP'lerinden gelir. Bu yüzden kiracı kaynak IP'ye bakarak ayırt edilemez.

1. Her kiracının trunk kaydı (`registration`) `line=yes` ve `endpoint=tN_trunk` ile yapılır. Asterisk, Contact adresine kayda özel bir `line` parametresi ekler. Gelen INVITE bu parametreyle doğru kiracının trunk'ına eşlenir.
2. Yedek olarak kayda özel bir `contact_user` tanımlanır ve `identify` kaydında `match_request_uri` ile eşlenir.
3. Ek kontrol olarak aranan DID'in o kiracıya ait olduğu `tN-inbound` context'inde doğrulanır. Tutmazsa arama reddedilir.

### Kiracı başına sınırlar

- Eş zamanlı çağrı limiti lisanstan okunur ve `GROUP_COUNT` ile uygulanır.
- Yurt dışı ve özel ücretli numaralara arama varsayılan olarak kapalıdır. Çok kiracılı santrallerde en büyük risk, hesabın ele geçirilip ücretli aramalarla dolandırıcılık (toll fraud) yapılmasıdır.

### Yönetim arayüzleri

AMI ve ARI yalnızca localhost'tan erişilebilir ve onlara yalnızca kontrol servisi bağlanır. Kiracıya gösterilen her olay, kiracı önekine göre süzülür.

## Lisans (Vozyy)

- Veritabanında kiracı başına bir yetki kaydı (`licenses`) tutulur: aktif mi, bitiş tarihi, en fazla kaç dahili, en fazla kaç eş zamanlı kanal, hangi modüller açık.
- Konfigürasyon üretici, lisansı aktif olmayan bir kiracının konfigürasyonunu üretmez. Böylece o kiracının trunk kaydı ve dahilileri kapanır.
- Vozyy'den lisansı okuyacak parça ayrı bir arayüz olarak bırakılır ve Vozyy sözleşmesi netleşince yazılır. README'deki kural gereği depoya geçici lisans anahtarı konmaz.

## Ağ ve güvenlik duvarı

| Port | Kimden | Amaç |
| --- | --- | --- |
| 22/tcp | Herkes (yalnızca anahtarla giriş) | SSH |
| 5060/udp+tcp | Yalnızca desteklenen operatörlerin IP listesi | Trunk sinyali |
| 5061/tcp | Herkes | Temsilci softphone'ları (TLS, Let's Encrypt sertifikası) |
| 10000–19999/udp | Herkes | RTP. Operatörlerin ses sunucuları sinyal sunucularından farklı IP'lerden gelebilir |
| 80/443 | Herkes | Sertifika ve 3. adımdan itibaren temsilci masası ve WebRTC (WSS) |

- Operatör IP listesi veritabanında (`operator_ip_ranges`) tutulur. Kontrol servisi bu listeyi `Santralio operatör: <ad>` açıklamalı ufw kuralları olarak günceller. Ayrı bir nftables kümesi kullanılmaz: ufw'nin engelleme kuralı, başka bir tablodaki izni geçersiz kılar.
- 5060 portu, ilk operatör tanımlanana kadar hiçbir adrese açılmaz.
- fail2ban'e bir Asterisk jail'i eklenir.
- `sip.santralio.site` Cloudflare'de **DNS only (gri bulut)** olmalı ve `116.203.184.30` adresini göstermeli. SIP ve RTP Cloudflare proxy'sinden geçemez.

## Veritabanı şeması (ilk hali)

| Tablo | İçerik |
| --- | --- |
| `tenants` | Kiracı kimliği, önek (`t1`), ad, durum |
| `licenses` | Kiracı başına yetkiler, kaynak (`vozyy`, `manual`), bitiş tarihi |
| `trunks` | Operatör, sunucu, kullanıcı adı, `secret_enc`, `key_id`, kayıt ayarları |
| `entry_points` | Kiracının giriş noktaları: kanal, adres (ses için DID) ve bağlı olduğu akış (bkz. Ek) |
| `extensions` | Dahili numarası, şifreli SIP şifresi, durum, mola durumu |
| `queues` | Kuyruk adı, strateji, zaman aşımı, anonslar |
| `queue_members` | Kuyruk ve dahili eşleşmesi |
| `menus` | Tuşlamalı menü: anons metni, zaman aşımı, deneme sayısı, varsayılan hedef. Ses dosyası `apply` sırasında metinden üretilir |
| `menu_options` | Menüde tuş → hedef (`queue:<ad>`, `menu:<ad>` ya da `schedule:<ad>`) |
| `schedules` | Çalışma saatleri: saat dilimi, açıkken gidilecek hedef, kapalı anonsu ve isteğe bağlı kapalı hedefi |
| `schedule_hours` | Açık aralıklar (gün ya da gün aralığı + saat aralığı); bir zamanlamada birden fazla olabilir |
| `schedule_holidays` | Tam gün kapalı tarihler; geçmiş tarihler dialplan'e yazılmaz |
| `operator_ip_ranges` | Operatör başına izinli sinyal IP aralıkları |
| `interactions` | Kanaldan bağımsız konuşma kaydı: kiracı, kanal, giriş noktası, kuyruk, temsilci, sonuç |
| `ai_providers` | Kiracı bazında STT/TTS/LLM sağlayıcısı ve şifreli API anahtarı (5. adımda kullanılır) |
| `queue_log` | Asterisk kuyruk olayları ve Santralio olayları (raporların kaynağı). Asterisk yalnızca satır ekler |
| `audit_log` | Kim, ne zaman, neyi değiştirdi (CLI'de sistem kullanıcısı, API'de `api:<e-posta>`) |
| `resellers` | Bayiler. Platform sahibi de bir bayidir (`Platform`, id 1) |
| `users` | Panel/API kullanıcıları: rol, kapsam (bayi, kiracı, temsilcinin dahilisi), scrypt şifre özeti |
| `sessions` | Oturumlar: belirtecin yalnızca SHA-256 özeti, bitiş süresi, iptal |

## Yönetim API'si, roller ve yetkiler

Hiyerarşi: **platform → bayi → kiracı (müşteri) → personel**.

- **Platform yöneticisi** her kiracıda, **bayi yöneticisi** kendi bayisinin kiracılarında bütün yetkilere sahiptir. Bu iki rol yalnızca CLI'den açılır.
- **Kiracının personeli** tek tip kullanıcıdır (`tenant_user`). Yetkileri, kiracının panelden kendi tanımladığı **rolden** gelir. Rol adı serbesttir ("Patron", "Hasta Danışmanı"…). Her yeni kiracıya örnek roller açılır: Patron, Müdür, Süpervizör, Temsilci. Kiracı bunları değiştirebilir, yenilerini ekleyebilir; personeli olmayan rolü silebilir.
- **Yetki kataloğu** `control/src/permissions.ts` dosyasındadır:

  | Yetki | Ne açar |
  | --- | --- |
  | `agent.desk` | Temsilci masası: arama alma, aktarma, mola. Dahili gerektirir |
  | `agent.outbound` | Dış arama, kiracının dış arama politikası içinde |
  | `calls.own` / `calls.all` | Kendi görüşmeleri / bütün görüşmeler |
  | `recordings.listen` | Görebildiği görüşmelerin kaydını dinleme |
  | `reports.view` | Raporlar |
  | `audit.view` | İşlem günlüğü |
  | `crm.use` | Müşteri kartları ve notlar |
  | `settings.manage` | Santral ayarları |
  | `staff.manage` | Personel ve roller |

- Kiracıya erişimin tek kapısı `can(kullanıcı, kiracı, ...yetkiler)` fonksiyonudur. Her API ucu gereken yetkiyi açıkça belirtir. Erişilemeyen kiracı için `404` döner, böylece başka kiracıların varlığı dışarıdan anlaşılmaz.
- Kullanıcının rolü kendi kiracısından olmak zorundadır; bu kural veritabanında bileşik yabancı anahtarla da korunur.
- **Kendini kilitleme korumaları:** Kullanıcı kendi rolünü değiştiremez, kendi hesabını kapatamaz ve kendi rolünden `staff.manage` yetkisini kaldıramaz.
- Gizli alanlar (trunk ve dahili şifreleri, contact token) API yanıtlarında hiç yer almaz. Değişiklik yapan her istek tek bir veritabanı işleminde çalışır; Asterisk'e uygulama, işlem tamamlandıktan sonra yapılır.
- Giriş denemeleri IP başına 15 dakikada 10 ile sınırlıdır. CLI ve API aynı işlem modülünü (`control/src/ops.ts`) kullanır.

### Üç adres ve tek giriş

| Adres | Kimin için | İçerik | Açılması için |
| --- | --- | --- | --- |
| `panel.santralio.site` | Patron, müdür | Ayarlar, personel, roller; platform yöneticisi için Sistem | `settings.manage` ya da `staff.manage` |
| `crm.santralio.site` | Yetkisi olan herkes | Görüşmeler, kayıtlar, raporlar, işlem günlüğü, müşteriler | `calls.*`, `reports.view`, `audit.view` ya da `crm.use` |
| `agent.santralio.site` | Personel | Temsilci masası; `/ws` yalnızca bu adreste | `agent.desk` ve bir dahili |

- Üç adres aynı uygulamayı ve aynı API'yi sunar; uygulama hangi ekranı açacağını adresten anlar.
- Oturum çerezi `Domain=.santralio.site; HttpOnly; Secure; SameSite=Lax` ile yazılır. Kullanıcı bir adreste giriş yapınca diğerlerine yeniden giriş yapmadan geçer.
- Değişiklik istekleri yalnızca bu üç adresin kaynağından (Origin) kabul edilir (CSRF koruması).

### Web paneli

- Üç adres de Cloudflare proxy'si arkasındadır. Caddy yalnızca Cloudflare IP'lerinden gelen bağlantıları kabul eder; böylece `CF-Connecting-IP` başlığına güvenilir ve giriş sınırı gerçek istemci IP'siyle çalışır.
- Panel tek sayfalık bir React uygulamasıdır. Aynı alan adındaki `/api` Caddy tarafından yönetim API'sine iletilir.
- Oturum belirteci `HttpOnly` çerezde durur; JavaScript belirteci görmez (bkz. "Üç adres ve tek giriş").
- İçerik güvenlik politikası (CSP) yalnızca aynı kaynaktan betik, stil ve ses yüklenmesine izin verir.
- Mobil uygulama aynı API'yi `Authorization: Bearer` belirteciyle kullanır.

## Arama kaydı ve raporlar

- **Kuyruk olayları** (`queue_log`: kuyruğa giriş, bağlanma, konuşma, terk, süre dolması) Asterisk tarafından doğrudan PostgreSQL'e yazılır (`res_config_pgsql`, `extconfig.conf`) ve yedek olarak dosyaya da yazılır. Asterisk'in `asterisk` veritabanı rolü yalnızca bu tabloya satır ekleyebilir; başka hiçbir tabloyu okuyamaz. Bağlantı Unix soketi ve yerel kullanıcı eşlemesiyle yapılır, şifre yoktur. Realtime yalnızca bu yazma yönü için kullanılır; kiracı ayarları ve şifreler realtime ile okunmaz.
- Santralio dialplan'i kendi olaylarını da yazar: `SANTRALIO_ENTER` (aranan numara, arayan), `SANTRALIO_NOAGENT` (müsait temsilci yok), `SANTRALIO_CLOSED` (mesai dışı), `SANTRALIO_RECORDING` (kayıt dosyası). Böylece hiç kuyruğa giremeyen aramalar da rapora girer.
- **Raporlar** bu olaylardan hesaplanır: gelen, cevaplanan, kaçan, cevaplanma oranı, hizmet seviyesi (20 sn), bekleme ve konuşma süreleri; kuyruk, temsilci ve gün bazında. Gün sınırları İstanbul saatine göredir.
- **Arama kaydı** kiracı bazında açılır, varsayılan olarak kapalıdır. Açıkken arayan kuyruğa girmeden önce bilgilendirme anonsunu (KVKK) duyar. Kayıt, temsilci aramayı açtığında `Queue()`'nun gosub parametresiyle başlar (`santralio-record`) ve yalnızca arayanla temsilci bağlıyken yapılır; bekleme müziği kaydedilmez.
- Kayıtlar `/var/lib/santralio/recordings/<önek>/<callid>.wav` altında durur (8 kHz WAV, dakikada yaklaşık 1 MB). Dizin kontrol servisine aittir; Asterisk grup üyesi olarak yazar.
- Kayıtları yalnızca kiracının yöneticileri dinleyebilir; her dinleme `audit_log`'a (`recording.listen`) yazılır. Saklama süresi kiracı bazındadır (varsayılan 90 gün); süresi dolan kayıtlar her gece `santralio-recordings-purge.timer` ile silinir.

### Temsilci masası (tarayıcıdan arama)

- Her dahilinin iki SIP uç noktası vardır: `tN_<dahili>` (softphone, TLS + SDES) ve `tN_<dahili>_web` (tarayıcı, WebRTC: DTLS-SRTP + ICE). Şifre aynı, kullanıcı adı ayrıdır.
- Tarayıcı SIP'i `wss://agent.santralio.site/ws` üzerinden konuşur. Caddy bağlantıyı açmadan önce oturumu `/api/auth/ws` ile doğrular; yalnızca dahilisi olan kullanıcı Asterisk'e (yalnızca `127.0.0.1:8088`) ulaşır. SIP kimlik doğrulaması ayrıca Asterisk'te yapılır.
- Ses Cloudflare'den geçmez: tarayıcı ile sunucu arasında doğrudan UDP 10000–19999 üzerinden akar. Sunucunun genel IP'si arayüzde olduğu için STUN/TURN gerekmez.
- Ses G.711 (alaw/ulaw) kalır: operatör hattıyla tarayıcı arasında dönüştürme yapılmaz.
- Kuyruk üyesi bir Local kanalıdır (`Local/<dahili>@tN-agent/n`): dahilinin iki cihazını birlikte çaldırır, hangisi önce açarsa arama ona bağlanır. Meşgul/müsait durumu iki cihazı birlikte izleyen hint'ten (`hint:<dahili>@tN-hints`) okunur.
- Temsilciye giden aramaya kuyruk adı (`X-Santralio-Queue`) ve aranan numara (`X-Santralio-DID`) SIP başlığı olarak eklenir; temsilci ekranında gösterilir.
- Mola durumu veritabanında (`extensions.paused`) tutulur, AMI `QueuePause` ile anında uygulanır ve kuyruk ayarına da yazılır; Asterisk yeniden yüklense de korunur.

## Depo yapısı

```
infra/asterisk/      ortak konfigürasyon: transport'lar, şablonlar, reject context'i
control/             Node 22 + TypeScript: migration'lar, şifreleme, üretici, CLI
docs/architecture.md bu belge
```

## Uygulama sırası ve kabul ölçütleri

| Adım | İş | Kabul ölçütü |
| --- | --- | --- |
| A. Sunucu hazırlığı | DNS düzeltmesi, yeniden başlatma, 2 GB swap. `asterisk`, `postgresql` ve `certbot` kurulumu | Sunucu yeni çekirdekle açıldı, `sip.santralio.site` sunucunun IP'sini gösteriyor |
| B. Temel Asterisk | Transport'lar, TLS, reject context'i. Henüz kiracı yok | Kimliği doğrulanmamış INVITE ve REGISTER istekleri reddediliyor |
| C. Kontrol servisi | Şema, şifreleme, konfigürasyon üretici, AMI ile yeniden yükleme. CLI komutları: `tenant create`, `trunk set`, `entry add` (ses için DID), `ext add`, `queue add` | Veritabanındaki kayıtlardan geçerli konfigürasyon üretiliyor, Asterisk hatasız yeniden yükleniyor |
| D. Test kiracısı `t1` | Netgsm trunk'ı, ses giriş noktası (DID), dahililer 1001 ve 1002, `t1_destek` kuyruğu | Netgsm kaydı `Registered` durumunda. DID aranınca anons duyuluyor, arama kuyruğa giriyor, 1001 ve 1002 çalıyor. Açılan çağrıda iki yönlü ses var |
| E. İzolasyon testi | Kendi `1001`'i olan sahte bir `t2` kiracısı açılır, testten sonra silinir | `t1_1001`, `t2`'nin dahili ve kuyruklarına ulaşamıyor. Bilinmeyen DID'e gelen arama reddediliyor. Lisansı kapatılan kiracının trunk kaydı düşüyor |

Bilerek sonraya bırakılanlar:
- WebRTC/WSS ve temsilcinin oturum açması (3. adım)
- Arama kaydı ve CDR (4. adım)
- Çalışma saatleri ve tuşlamalı menü (karşılama ve yönlendirme kapsamı)

## Personel, işlem günlüğü ve aktarma

- **Personel:** `staff.manage` yetkisi olan kullanıcı, panelden kendi kiracısına personel açar ve personele bir rol seçer. Geçici şifre rastgele üretilir ve yalnızca bir kez gösterilir. Temsilci masasını kullanan bir rol için dahili gerekir. Dahili burada açılmaz: önce Dahililer sekmesinden tanımlanır, Kuyruklar sekmesinden bir kuyruğa eklenir, sonra personele atanır. Bir dahili aynı anda tek bir açık hesaba bağlanabilir. Hesap kapatılınca o hesabın açık oturumları da kapanır.
- **İşlem günlüğü:** Giriş, çıkış, ayar değişiklikleri, personel işlemleri, kayıt dinleme, mola ve temsilci masasına bağlanma `audit_log`'a yazılır: kim, ne zaman, hangi IP'den. Kiracı yöneticisi kendi kiracısının günlüğünü, platform yöneticisi bütün günlüğü görür.
- **Sistem durumu:** Yalnızca platform yöneticisi görür. İçeriği: santralin çalışma süresi, süren arama sayısı, operatör hatlarının kaydı, disk ve son 50 santral uyarısı.
- **Aktarma:** Temsilci görüşmeyi tarayıcıdan bir kuyruğa (`q-<kuyruk>`) ya da bir dahiliye kör aktarır (SIP REFER). Hedef, temsilcinin kendi kiracısının `tN-internal` context'inde çözülür; başka bir kiracıya ya da dış hatta aktarma yapılamaz. Aktarılan görüşme yeni kuyrukta ayrı bir satır olarak rapora girer.

## Dış arama

- **Politika** kiracı bazındadır (`outbound_policies`) ve **yalnızca platform yöneticisi** değiştirir. Politikada şunlar tanımlanır: hangi yurt içi numara türleri açık (mobil, sabit, 0850/444, 0800), yurt dışında hangi ülke kodları açık, eş zamanlı dış arama sınırı, günlük arama sınırı ve en uzun görüşme süresi.
- **Sektör şablonları** (`control/src/outbound.ts`): Yalnızca gelen arama, Acente (yurt içi), Otel / turizm, Sağlık turizmi. Şablon kuralları doldurur; ayrıntılar sonra elle değiştirilebilir.
- **Her zaman engelli:** Özel ücretli (0900, 0898 vb.) ve kısa numaralar engellidir. +90 (Türkiye) ve +1 (Kuzey Amerika numara planı; Karayipler'deki yüksek ücretli hatları da kapsar) yurt dışı listesine eklenemez. Santral yalnızca politikadaki desenlere uyan numaraları operatöre gönderir; gerisi `reject`'e düşer.
- **Kiracının payı:** Kiracı, politikanın içinde, hangi rolün dış arama yapabileceğini `agent.outbound` yetkisiyle belirler. Bu yetkiyle açık bir hesaba bağlı dahilinin endpoint'i `tN-internal-out` context'ini kullanır; diğer dahililer yalnızca iç arama yapabilir. Rol ya da personel değişince santral hemen yeniden üretilir.
- **Sınırlar:** Eş zamanlı sınır kanal grubuyla (`GROUP(santralio-out)`), günlük sınır AstDB sayacıyla (`santralio_out/<önek>/<gün>`), en uzun süre `Dial` seçeneğiyle (`S`) uygulanır. Kiracının genel kanal sınırı da geçerlidir. Karşı tarafa kiracının hat numarası gösterilir.
- **Kayıt ve rapor:** Kayıt açıksa dış arama da kaydedilir ve karşı tarafa bilgilendirme anonsu çalınır. Dış aramalar görüşme listesine "Dış arama" olarak girer. Raporda gelen çağrı oranlarına karışmaz, ayrı özetlenir.

## Kurulum modları: paylaşımlı ve müşteriye özel sunucu

Yazılım her iki modda da aynıdır; değişen yalnızca kaç kiracının hangi sunucuda çalıştığıdır.

| Mod | Ne zaman | Nasıl |
| --- | --- | --- |
| **Paylaşımlı** | Varsayılan. Küçük ve orta müşteriler | Kiracılar Santralio'nun sunucularında, birbirinden izole çalışır (bugünkü yapı) |
| **Müşteriye özel sunucu** | Veri yerelliği (KVKK), yüksek hacim ya da kurumsal talep | Müşteri için ayrı bir sunucuya tam bir Santralio kurulur: kendi veritabanı, kendi santrali, kendi paneli |

Otomatik kurulum için planlanan yapı:

1. **Tek komutla kurulum (`infra/install-all.sh`).** Boş bir Ubuntu sunucusunda bütün adımları sırayla ve tekrar çalıştırılabilir biçimde yapar: paketler, Piper, Asterisk ayarları, sertifikalar, kontrol servisi, panel, güvenlik duvarı ve fail2ban. Bugün bu adımlar `deploy.sh`, `install.sh` ve `web-deploy.sh` olarak ayrı duruyor; alan adları ve IP birkaç yerde sabit yazılı. Önce bunlar tek bir ayar dosyasına (`/etc/santralio/site.env`: alan adları, genel IP, e-posta) bağlanacak.
2. **Sunucu açma ve DNS (`infra/provision`).** Hetzner API'si ile sunucuyu açar, Cloudflare API'si ile `sip.<alan>` (proxy'siz) ve `panel.<alan>` (proxy'li) kayıtlarını oluşturur, SSH ile `install-all.sh`'yi belirli bir sürümle (git etiketi) çalıştırır. Müşteri kendi sunucusunu verirse yalnızca son adım çalışır.
3. **Sürüm ve güncelleme.** Her kurulum bir sürüm etiketine bağlıdır. Güncelleme aynı betiği yeni etiketle yeniden çalıştırır; veritabanı migration'ları sırayla uygulanır.
4. **Lisans.** Müşteriye özel sunucu da lisansını Vozyy'den okur. Lisans kapanırsa o sunucudaki kiracı kapanır.
5. **Yedek ve izleme.** Veritabanı ve kayıtlar her gece sunucu dışına yedeklenir. Merkezi bir izleme ekranı bütün sunucuların sağlık durumunu toplar.

## Kapasite ve büyüme

İlk sunucu Hetzner ARM64, 2 vCPU ve 4 GB RAM. Pilot için yeterli: birkaç kiracı ve 20–30 eş zamanlı G.711 çağrısı, ses dönüştürmesi olmadan.

Büyüme sırası:
1. Veritabanı ayrı sunucuya taşınır.
2. Öne Kamailio SBC konur.
3. Kiracılar birden fazla Asterisk sunucusuna dağıtılır.

Kiracı önekleri ve veritabanı merkezli yapı bu geçişi baştan mümkün kılar.

## Ek: Kanaldan bağımsız mimari

README'deki ilk kanal sestir, ama yazılı kanallar da ileride gelecek. Çekirdek bu yüzden baştan kanala bağlı kurulmaz. 2. adımda yalnızca ses kanalı yazılır. Bu ek, o kodun hangi sınırlara uyacağını belirler.

### Giriş noktaları (`entry_points`)

Bir kiracıya ulaşılan her adres bir giriş noktasıdır. Numara, kanal ve akış birbirinden ayrı tutulur.

| Alan | Örnek | Açıklama |
| --- | --- | --- |
| `tenant_id` | `t1` | Giriş noktasının sahibi olan kiracı |
| `channel` | `voice` | `voice`, ileride `whatsapp` ve `webchat` |
| `address` | `+90850xxxxxxx` | Kanala göre adres: ses için DID, WhatsApp için numara, web sohbeti için widget kimliği |
| `trunk_id` | `t1_trunk` | Yalnızca ses kanalında: aramanın geldiği trunk |
| `flow` | `queue:t1_destek` | Hedef akış: şimdilik bir kuyruk. 5. adımdan sonra yapay zekâ karşılaması, sonra kuyruk |
| `enabled` | `true` | Lisans ve kiracı durumuna göre açık ya da kapalı |

- Gelen aramada DID doğrulaması (bkz. "Gelen aramanın doğru kiracıya düşmesi") bu tablodan yapılır. Bir adres yalnızca bir kiracıya ait olabilir (`channel` ile `address` birlikte tekil).
- `tN-inbound` dialplan'i bu tablodan üretilir. Kanal eklemek, ses kanalının koduna dokunmadan yeni bir kanal bağdaştırıcısı yazmak demektir.

### Katmanlar

```
 Kanal bağdaştırıcıları     voice (Asterisk) │ whatsapp │ webchat   (ileride)
            │  ortak olaylar: konuşma başladı, mesaj/ses parçası, aktarım, bitti
            ▼
 Konuşma çekirdeği          kiracı, giriş noktası, konuşma (interaction), akış, kuyruk, temsilci
            │
            ▼
 Sağlayıcı arayüzleri       STT │ TTS │ LLM   (kiracı bazında seçilir, değiştirilebilir)
```

- **Kanal bağdaştırıcısı**, kanalın kendi protokolünü (SIP/RTP, WhatsApp API, WebSocket) ortak olaylara çevirir. Ses bağdaştırıcısı Asterisk ile ARI üzerinden konuşur. Yapay zekâya ses gerekince sesi `AudioSocket` ya da ARI `ExternalMedia` ile akıtır.
- **Konuşma çekirdeği** kanalı bilmez. Bir konuşma kaydı (`interaction`) kanal, giriş noktası, kiracı ve sonuçla birlikte tutulur. Kuyruk, temsilciye aktarım, not, sonuç kodu ve rapor bu kayıt üzerinden yürür. Böylece 3. adımdaki temsilci masası ve 9. adımdaki raporlar her kanalda aynı çalışır.
- **Kiracı izolasyonu** bütün katmanlarda aynı kuralla korunur. Her kayıt `tenant_id` taşır. Bir kiracının olayı, başka bir kiracının akışına ya da sağlayıcı hesabına gitmez.

### Değiştirilebilir STT, TTS ve LLM

Yapay zekâ sağlayıcıları koda sabit yazılmaz. Her biri bir arayüzün arkasında durur:

| Arayüz | Girdi → çıktı | Not |
| --- | --- | --- |
| `SpeechToText` | Ses akışı (8 kHz G.711 ya da 16 kHz PCM) → ara ve kesin transkript | Akışlı çalışmalı. Türkçe birinci dil |
| `TextToSpeech` | Metin → ses akışı | Akışlı çalışmalı. Kiracı bazında ses seçimi |
| `LanguageModel` | Konuşma geçmişi, bilgi tabanı, araçlar → yanıt ve aksiyon (ör. "temsilciye aktar") | Aktarım her akışta bulunur (Ürün ilkesi 2) |

- Sağlayıcı seçimi kiracı bazında `ai_providers` tablosunda tutulur: arayüz, sağlayıcı, model, ayarlar ve şifreli API anahtarı. API anahtarları trunk şifreleriyle aynı yöntemle saklanır (AES-256-GCM, `key_id`).
- Her arayüz için bir yedek sağlayıcı tanımlanabilir. Sağlayıcı yanıt vermezse ya da zaman aşımına düşerse görüşme kesilmez. Arama kuyruğa, yani bir temsilciye düşer.
- Kiracı kendi sağlayıcı hesabını getirebilir ya da Santralio'nun hesabını kullanabilir. Hangisinin açık olduğu lisanstaki yetkiyle belirlenir.
- Sağlayıcıya gönderilen ses ve metin, kayıt ve kişisel veri kurallarına tabidir (Ürün ilkesi 5). Hangi kiracının verisinin hangi sağlayıcıya gittiği `audit_log`'a yazılır.
- Sağlayıcı arayüzleri 5. adımda yazılır. 2. adımda yalnızca `entry_points` tablosu ve `interaction` kaydı bu sınırlara göre kurulur.

## Açık kararlar

1. **Test kiracısının lisansı:** Vozyy sözleşmesi yokken `t1`, depoya anahtar konmadan, veritabanına elle girilmiş ve `source=manual` olarak işaretlenmiş bir yetki kaydıyla mı çalışacak?
2. **Netgsm bilgileri:** SIP kullanıcı adı, sunucu adresi ve test DID'i gerekiyor. Netgsm panelinde IP kısıtlaması varsa sunucunun IP'si eklenmeli.
3. **Kontrol servisi dili:** Öneri Node 22 + TypeScript. Sunucuda kurulu ve 3. adımdaki temsilci masasıyla aynı dil olur.
