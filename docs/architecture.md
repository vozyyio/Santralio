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

- Operatör IP listesi veritabanında (`operator_ip_ranges`) tutulur. Kontrol servisi bu listeyi nftables'ta bir küme olarak günceller.
- fail2ban'e bir Asterisk jail'i eklenir.
- `sip.santralio.site` Cloudflare'de **DNS only (gri bulut)** olmalı ve `116.203.184.30` adresini göstermeli. SIP ve RTP Cloudflare proxy'sinden geçemez.

## Veritabanı şeması (ilk hali)

| Tablo | İçerik |
| --- | --- |
| `tenants` | Kiracı kimliği, önek (`t1`), ad, durum |
| `licenses` | Kiracı başına yetkiler, kaynak (`vozyy`, `manual`), bitiş tarihi |
| `trunks` | Operatör, sunucu, kullanıcı adı, `secret_enc`, `key_id`, kayıt ayarları |
| `dids` | Numara ve hangi kiracıya, hangi hedefe bağlı olduğu |
| `extensions` | Dahili numarası, şifreli SIP şifresi, durum |
| `queues` | Kuyruk adı, strateji, zaman aşımı, anonslar |
| `queue_members` | Kuyruk ve dahili eşleşmesi |
| `operator_ip_ranges` | Operatör başına izinli sinyal IP aralıkları |
| `audit_log` | Kim, ne zaman, neyi değiştirdi |

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
| C. Kontrol servisi | Şema, şifreleme, konfigürasyon üretici, AMI ile yeniden yükleme. CLI komutları: `tenant create`, `trunk set`, `did add`, `ext add`, `queue add` | Veritabanındaki kayıtlardan geçerli konfigürasyon üretiliyor, Asterisk hatasız yeniden yükleniyor |
| D. Test kiracısı `t1` | Netgsm trunk'ı, DID, dahililer 1001 ve 1002, `t1_destek` kuyruğu | Netgsm kaydı `Registered` durumunda. DID aranınca anons duyuluyor, arama kuyruğa giriyor, 1001 ve 1002 çalıyor. Açılan çağrıda iki yönlü ses var |
| E. İzolasyon testi | Kendi `1001`'i olan sahte bir `t2` kiracısı açılır, testten sonra silinir | `t1_1001`, `t2`'nin dahili ve kuyruklarına ulaşamıyor. Bilinmeyen DID'e gelen arama reddediliyor. Lisansı kapatılan kiracının trunk kaydı düşüyor |

Bilerek sonraya bırakılanlar:
- WebRTC/WSS ve temsilcinin oturum açması (3. adım)
- Arama kaydı ve CDR (4. adım)
- Çalışma saatleri ve tuşlamalı menü (karşılama ve yönlendirme kapsamı)

## Kapasite ve büyüme

İlk sunucu Hetzner ARM64, 2 vCPU ve 4 GB RAM. Pilot için yeterli: birkaç kiracı ve 20–30 eş zamanlı G.711 çağrısı, ses dönüştürmesi olmadan.

Büyüme sırası:
1. Veritabanı ayrı sunucuya taşınır.
2. Öne Kamailio SBC konur.
3. Kiracılar birden fazla Asterisk sunucusuna dağıtılır.

Kiracı önekleri ve veritabanı merkezli yapı bu geçişi baştan mümkün kılar.

## Açık kararlar

1. **Test kiracısının lisansı:** Vozyy sözleşmesi yokken `t1`, depoya anahtar konmadan, veritabanına elle girilmiş ve `source=manual` olarak işaretlenmiş bir yetki kaydıyla mı çalışacak?
2. **Netgsm bilgileri:** SIP kullanıcı adı, sunucu adresi ve test DID'i gerekiyor. Netgsm panelinde IP kısıtlaması varsa sunucunun IP'si eklenmeli.
3. **Kontrol servisi dili:** Öneri Node 22 + TypeScript. Sunucuda kurulu ve 3. adımdaki temsilci masasıyla aynı dil olur.
