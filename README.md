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

Kurulum, çalıştırma ve yapılandırma adımları ilk yazılım modülüyle birlikte bu dosyaya eklenecek.

## Lisanslama ve satış

Santralio’nun ticari lisanslama ve satış mantığı Vozyy ile sağlanır. Müşteri lisansı [Vozyy mağazasından](https://vozyy.pro/Shop) çıkar: hazır ürün olarak tek fiyatla, ya da entegrasyon, modül ve lisans planı sırasıyla.

Vozyy lisansı basar. Santralio o lisansın açtığı yetkilerle kiracıyı çalıştırır. Süresi dolmuş veya hiç açılmamış bir yetki, ilgili modülü kapalı tutar.

Bu deponun kapsamı çağrı merkezi yazılımıdır. Satış ekranı, fiyat kataloğu, ödeme tahsilatı ve lisans basımı Vozyy’de kalır. Lisansın hangi uçtan, hangi alanlarla okunacağı Vozyy sözleşmesi netleşince yazılır. O sözleşme yazılmadan bu depoya geçici lisans anahtarı veya deneme ödeme akışı eklenmez.

Kaynak kodun dağıtım lisansı ayrıca seçilecektir. Bu seçim, Vozyy üzerinden satılan ürün lisansından ayrıdır.
