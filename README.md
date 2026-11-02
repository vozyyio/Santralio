# Santralio

Yapay zeka destekli yeni nesil çağrı merkezi ve santral yazılımı.

Santralio, gelen ve giden aramaları karşılayan, kuyruğa alan, doğru kişiye yönlendiren ve görüşmenin her adımında yapay zekâyı kullanan bir çağrı merkezi platformudur. Klasik santralin arama altyapısını, temsilci masası ve yapay zeka katmanıyla aynı üründe toplar.

**Durum:** Ürün tanımı bu belgeyle başlıyor. Yazılım modülleri sırayla, her biri çalışır hale geldikten sonra eklenecek. Aşağıdaki başlıklar hedeflenen kapsamdır; kurulu bir özellik listesi değildir.

## Kısa özet

| | |
| --- | --- |
| Ürün | Çağrı merkezi + santral |
| İlk dil | Türkçe |
| İlk kanal | Ses (telefon görüşmesi) |
| Yapay zekânın yeri | Karşılama, yönlendirme, temsilciye anlık destek, görüşme özeti |
| Satış ve ürün lisansı | Vozyy |
| Şu an depoda | Bu ürün çerçevesi |

**English.** Santralio is a next-generation, AI-assisted contact center and PBX. It will handle inbound and outbound calls, queue and route them, and support human agents with transcription, suggestions, and post-call summaries. Commercial licensing and sales stay in Vozyy: Vozyy issues the license, Santralio runs the tenant and the call center. Implementation starts module by module after this product frame.

## Ne işe yarar

Bir çağrı merkezinde üç iş aynı anda yürür: arama bağlanır, müşteri derdini anlatır, temsilci çözer. Santralio bu üç işi ayrı araçlara bölmez.

- **Santral.** Arama kurulur, kuyruğa girer, çalar, aktarılır ve kayda alınır.
- **Çağrı merkezi.** Temsilci gelen işi görür, konuşur, not düşer ve çağrıyı sonuçlandırır.
- **Yapay zeka.** Karşılar, niyeti anlar, çözebildiği işi tamamlar, temsilciye anlık destek verir ve görüşmeyi özetler.

Yapay zeka tekrarlayan karşılama ve yönlendirmeyi üstlenir. Temsilci, görüşmeyi istediği anda devralır. Devralınan çağrıda müşterinin ne söylediği ve nerede kalındığı temsilcinin ekranında hazır olur.

## Kimler için

- Kendi çağrı merkezini kurmak isteyen işletmeler
- Mevcut santralini temsilci ekranı ve yapay zeka ile güçlendirmek isteyen ekipler
- Gelen arama, giden arama veya her ikisini birden yürüten operasyonlar

İlk hedef, Türkçe konuşan çağrı merkezleridir.

## Ürün ilkeleri

1. **Önce ses.** Ürünün omurgası telefon görüşmesidir. Yazılı kanallar ses akışı oturduktan sonra ele alınır.
2. **İnsan devralabilir.** Her yapay zeka akışında temsilciye aktarma vardır. Karar ve kapanış temsilcide kalabilir.
3. **Türkçe birinci dildir.** Karşılama, transkript, öneri ve özet Türkçe için tasarlanır.
4. **Modül modül ilerleme.** Her yetenek ayrı çalışılır. Yeni parça, çalışan parçanın üzerine eklenir.
5. **Kayıt ve kişisel veri tasarımın parçasıdır.** Arama kaydı, transkript ve müşteri verisi ürün akışının içinde, görünür kurallarla ele alınır.
6. **Satış ve lisans Vozyy’de.** Paket, modül, plan, fiyat ve tahsilat Vozyy’dedir. Santralio, Vozyy’nin bastığı lisansla kiracıyı ve çağrı merkezini çalıştırır.

## Planlanan kapsam

### 1. Çağrı altyapısı

Gelen ve giden arama, dahili, kuyruk, bekleme anonsu, aktarma ve kayıt.

### 2. Karşılama ve yönlendirme

Açılış anonsu, tuşlama veya konuşarak menü, çalışma saatleri, niyete ve beceriye göre kuyruk seçimi.

### 3. Temsilci masası

Temsilcinin oturum açtığı ekran: gelen çağrı, müşteri bağlamı, not, durum (müsait, molada, görüşmede) ve çağrı kontrolleri.

### 4. Süpervizör

Kuyruk doluluğu, bekleyen çağrı, temsilci durumu, dinleme ve müdahale.

### 5. Yapay zeka asistanı

Sesli karşılama, sık sorulan işlemler, bilgi tabanından yanıt. Çözülemeyen görüşme, kısa bir özetle birlikte temsilciye aktarılır.

### 6. Temsilciye anlık destek

Konuşmanın yazıya dökülmesi, önerilen yanıt, konu ve duygu sinyali. Öneri ekranda durur; ne söyleneceğine temsilci karar verir.

### 7. Görüşme sonrası

Kısa özet, sonuç kodu ve kalite için işaretlenen anlar.

### 8. Dış arama

Arama listesi, kampanya ve temsilciye veya asistana bağlanan giden arama.

### 9. Raporlar

Cevaplanan ve kaçan çağrı, bekleme süresi, ortalama görüşme süresi ve temsilci verimi.

### 10. Entegrasyonlar

Müşteri kaydı, bilet ve bildirim sistemleriyle bağlantı. İlk sürüm tek bir net entegrasyonla başlar. Kapsam, o entegrasyon seçilirken belirlenir.

## İlerleme sırası

Yazılım aşağıdaki sırayla ele alınacak. Bir adım çalışır hale gelmeden sonrakine geçilmez. Teknoloji seçimi, ilgili adım başlarken netleşir.

1. Ürün çerçevesi (bu belge)
2. Çağrının bağlanması: gelen arama, kuyruk, temsilciye düşmesi
3. Temsilci masasının ilk ekranı
4. Kayıt ve temel rapor
5. Yapay zeka ile karşılama ve temsilciye aktarma
6. Transkript, özet ve anlık destek
7. Dış arama, süpervizör ve entegrasyonlar

## Depo

| Yol | Durum |
| --- | --- |
| `README.md` | Ürün çerçevesi |
| `docs/architecture.md` | Çağrı altyapısı mimarisi (öneri) |
| `infra/asterisk/` | Ortak Asterisk ayarları, kurulum betiği (`deploy.sh`), sertifika kancası ve ret testi |
| `infra/fail2ban/` | Asterisk için fail2ban jail'i |
| `infra/firewall-sync.sh` | Operatör IP aralıklarını 5060 için ufw iznine çevirir (yalnızca ekler) |
| `control/` | Kontrol servisi (Node 22 + TypeScript): şema, şifreleme, konfigürasyon üretici, CLI |

## Kurulum (sunucu)

Ubuntu 26.04, Asterisk 22 ve PostgreSQL 18 paketleri kurulu olmalı (`asterisk`, `asterisk-modules`, `asterisk-core-sounds-en-wav`, `asterisk-moh-opsound-wav`, `postgresql`, `certbot`; menü anonsları için `sox` ve yedek ses olarak `espeak-ng`, `mbrola-tr2`).

Anonslar varsayılan olarak [Piper](https://github.com/rhasspy/piper) ile sunucuda yerel üretilir; metin dış servise gitmez:

```sh
curl -LO https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz   # sha256 fea0fd2d87c54dbc…
sudo tar xzf piper_linux_aarch64.tar.gz -C /opt/santralio/ --no-same-owner
B=https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium
curl -LO $B/tr_TR-dfki-medium.onnx -LO $B/tr_TR-dfki-medium.onnx.json                               # sha256 2844717f524ab965…
sudo install -D -m 0644 -t /opt/santralio/voices/ tr_TR-dfki-medium.onnx tr_TR-dfki-medium.onnx.json
```

Piper ya da ses modeli yoksa espeak-ng kullanılır. Motor değişince `santralio apply` anonsları yeniden üretir.. `sip.santralio.site` Cloudflare'de proxy'siz olmalı.

```sh
sudo certbot certonly --standalone -d sip.santralio.site --key-type ecdsa
sudo install -m 0755 infra/asterisk/cert-hook.sh /etc/letsencrypt/renewal-hooks/deploy/santralio-asterisk.sh
sudo install -m 0644 infra/fail2ban/santralio-asterisk.conf /etc/fail2ban/jail.d/
sudo ufw allow 5061/tcp && sudo ufw allow 10000:19999/udp
sudo infra/asterisk/deploy.sh --restart
sudo control/install.sh
```

Kiracı açmak (örnek):

```sh
santralio tenant create "Örnek Otel"                 # -> t2
santralio license set-manual t2 --max-ext 5 --max-channels 4 --until 2027-01-31
santralio queue add t2 destek --number 8001
santralio ext add t2 1001 --name "Resepsiyon"        # SIP şifresini bir kez gösterir
santralio queue member add t2 destek 1001
santralio trunk set t2 --operator netgsm --server <sunucu> --username <kullanıcı>   # şifre gizli sorulur
santralio entry add t2 voice 908501234567 --flow queue:destek
santralio menu add t2 ana --text "Örnek Otel'e hoş geldiniz. Rezervasyon için 1'e basınız." --default queue:destek
santralio menu option t2 ana 1 queue:destek
santralio entry flow t2 908501234567 menu:ana        # aramayı menüye bağlar
santralio apply
```

Testler: `cd control && npm test`, `python3 -I infra/asterisk/tests/check_reject.py`, `infra/asterisk/tests/check_register.py`, `check_inbound.py` (kullanım dosyaların başında), `sudo infra/asterisk/tests/check_isolation.sh t1 t2`.

## Lisanslama ve satış

Santralio’nun ticari lisanslama ve satış mantığı Vozyy ile sağlanır. Müşteri lisansı [Vozyy mağazasından](https://vozyy.pro/Shop) çıkar: hazır ürün olarak tek fiyatla, ya da entegrasyon, modül ve lisans planı sırasıyla.

Vozyy lisansı basar. Santralio o lisansın açtığı yetkilerle kiracıyı çalıştırır. Süresi dolmuş veya hiç açılmamış bir yetki, ilgili modülü kapalı tutar.

Bu deponun kapsamı çağrı merkezi yazılımıdır. Satış ekranı, fiyat kataloğu, ödeme tahsilatı ve lisans basımı Vozyy’de kalır. Lisansın hangi uçtan, hangi alanlarla okunacağı Vozyy sözleşmesi netleşince yazılır. O sözleşme yazılmadan bu depoya geçici lisans anahtarı veya deneme ödeme akışı eklenmez.

Kaynak kodun dağıtım lisansı ayrıca seçilecektir. Bu seçim, Vozyy üzerinden satılan ürün lisansından ayrıdır.
