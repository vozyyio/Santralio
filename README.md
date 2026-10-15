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
| Şu an depoda | Bu ürün çerçevesi |

**English.** Santralio is a next-generation, AI-assisted contact center and PBX. It will handle inbound and outbound calls, queue and route them, and support human agents with transcription, suggestions, and post-call summaries. Implementation starts module by module after this product frame.

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

Kurulum, çalıştırma ve yapılandırma adımları ilk yazılım modülüyle birlikte bu dosyaya eklenecek.

## Lisans

Lisans henüz seçilmedi.
