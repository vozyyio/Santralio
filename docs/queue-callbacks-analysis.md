# Kuyrukta geri aranma ve görüşme sonrası analiz

## "Sıranız gelince sizi arayalım"

Panel → Kuyruklar → her kuyrukta "Sıranız gelince sizi arayalım". Açmak için kiracının açık bir hattı (SIP trunk) olmalı.

1. Kuyrukta bekleyen arayana `cb_offer_after_s` saniyede bir teklif anonsu çalınır (queues.conf `periodic-announce`).
2. 1'e basan kuyruktan çıkar (queues.conf `context=tN-qcb-<kuyruk>`). Numara görünüyorsa `SANTRALIO_QCB_REQUEST` queue_log'a yazılır, "talep alındı" anonsu çalınır, kapatılır. Numara görünmüyorsa anons çalınır ve kuyruğa geri alınır (sırası kaybolur).
3. Kontrol servisi (5 sn'de bir) talepten iş açar. Sıra, arayanın kuyruğa **ilk giriş** zamanıdır.
4. Asterisk'e `queue show` ile sorulur: müsait (molada olmayan, boşta) temsilci sayısı, kuyrukta bekleyenler ve en uzun bekleme. Temsilci boşsa ve kuyrukta bu talepten önce girmiş biri beklemiyorsa arayan kiracının hattından aranır. Aynı anda aranan iş sayısı müsait temsilciyi ve lisans kanal sınırını aşmaz.
5. Açınca `tN-qcb-out,q<kuyruk>`: `SANTRALIO_QCB_ANSWERED` yazılır, "bağlıyoruz" anonsu, `QUEUE_PRIO=10` ile aynı kuyruğa (karşılama tekrarlanmadan) girilir. Temsilci arayanın numarasını görür.
6. Açmazsa 2 dk arayla en fazla 3 deneme; sonra `no_answer`. `cb_expire_min` içinde sıra gelmezse `expired`. Santral kapalıyken aranmaz. Özellik kapatılınca bekleyen talepler iptal edilir.

Raporlarda bu görüşmeler "Geri arama istedi" sonucuyla görünür (kapattı sayılmaz). Webhook olayları: `queue_callback.requested`, `queue_callback.connected`, `queue_callback.failed`.

Doğrulama: dialplan ve queues.conf yerel Asterisk 20.6'da yüklendi; talep ve geri arama context'leri Local kanalla çalıştırıldı, queue_log olayları beklendiği gibi yazıldı. Gerçek hatla test edilmedi.

## Görüşme sonrası yapay zekâ analizi

Panel → Yapay zekâ → "Görüşme sonrası analiz" (varsayılan kapalı; her görüşme için model ücreti oluşur). Sonuçlar CRM → Yapay zekâ'da.

- Yapay zekâ görüşmesi bittikten en az 30 sn sonra döküm, seçilen modelle (varsayılan Sonnet 5.5; Haiku, Opus ve Fable 5.2 seçilebilir) incelenir. Çalıştırma `santralio-ai` servisindedir (Anthropic anahtarı orada), 30 sn'de bir en fazla 5 oturum.
- Çıktı: özet, konu (kiracının en fazla 30 konuluk listesinden ya da "diğer"), müşterinin genel hali (memnun/nötr/olumsuz), sonuç (asistan çözdü / aktarıldı / çözülmedi / belirsiz), takip edilecek iş.
- 12 ve daha uzun rakam dizileri (kart, IBAN) modele gitmeden maskelenir. Döküm "veri, talimat değil" olarak verilir; model çıktısı ayrıca doğrulanır (listede olmayan konu "diğer", uzunluk sınırı).
- Hata olursa 5 dk sonra yeniden denenir (en fazla 3 kez). Son 7 günden eski oturumlar analiz edilmez.
- Webhook: `call.analyzed`.
- Fable 5.2 sıcaklık ayarı ve zorunlu araç kullanımı kabul etmez; istemci bunları göndermez. Fable 30 günlük veri saklama gerektirir (KVKK metnine eklenmeli).

Henüz yok: temsilcinin yaptığı (kayıtlı) görüşmelerin yazıya dökülüp analiz edilmesi. Azure toplu yazıya dökme gerektirir; gerçek hesapla test edilebilecek bir sonraki adım.
