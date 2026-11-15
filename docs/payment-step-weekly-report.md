# Santral ödeme adımı ve haftalık yapay zekâ raporu

## Ödeme adımı (`payment:<profil>`)

Menü tuşu, giriş noktası, çalışma saati ya da yapay zekâ yönlendirmesi olarak "Ödeme bağlantısı: <profil>" seçilebilir.

- Yalnızca tutarı **sabit** ya da **işletme sisteminden sorgulanan**, açık, bağlantıyla ödenebilen ve kullanılabilir sağlayıcısı olan profiller. Tutarı temsilcinin girdiği profil santral adımı olamaz (hem panelde hem sunucuda reddedilir).
- Arayana profilin soru metni okunur (boşsa: "<başlık> için ödeme bağlantısını cep telefonunuza kısa mesajla göndermemizi isterseniz 1'e basın.").
- 1: arayan numarası Türkiye cep numarasıysa `SANTRALIO_PAY_REQUEST` (profil | numara | ivr/ai) queue_log'a yazılır, "bağlantı gönderiliyor" anonsu çalınır. Santral tutar taşımaz.
- Kontrol servisi (5 sn) talebi okur ve `createRequest` ile bağlantıyı oluşturup SMS gönderir. Tutar profilden ya da işletme sisteminden gelir.
- Numara taklidiyle başkasına SMS yağdırılmasın diye: aynı numaraya kiracı başına günde en fazla 3, kiracı başına günde 300 santral/yapay zekâ talebi. Aşılırsa işlem günlüğüne `payments.ivr.limited`.
- Yapay zekâ: akışa ödeme hedefi eklenirse asistan arayan isteyince oraya aktarır; tutar söylemez, kart bilgisi istemez. Talep `created_by = ai` olarak kaydedilir.
- **Tuşlayarak ödeme** (2): sağlayıcının güvenli tuşlama hizmeti ve işletmenin MOTO onayı gerekir; hiçbir sağlayıcıda henüz bağlı değil. Bağlanınca soru "bağlantı için 1, tuşlayarak ödemek için 2" olur.

Doğrulama: dialplan yerel Asterisk 20.6'da Local kanalla çalıştırıldı (cep numarası → talep yazıldı ve `ai` işaretlendi; sabit hat → numara görünmüyor anonsu).

## Haftalık yapay zekâ raporu

Panel → Yapay zekâ → "Haftalık yapay zekâ raporu" (varsayılan kapalı; görüşme analizinin açık olması gerekir). Rapor CRM → Yapay zekâ'da ve `report.weekly` webhook'unda.

- Her hafta (Pazartesi–Pazar, İstanbul) bittikten sonra yapay zekâ servisi geçen haftanın analizlerinden (en az 5) yöneticiye rapor yazar: tek cümlelik özet, öne çıkanlar, sorunlar, bu hafta yapılabilecekler (her biri en fazla 4 madde).
- Modele sayılar ve en fazla 200 görüşme analizi gider (çözülmeyen ve olumsuzlar önce); arayan numarası gitmez, uzun rakamlar maskelenir.
- Rapor modeli ayrı seçilir (haftada bir çalıştığı için Fable 5.2 burada mantıklı).
- Hata olursa 30 dk sonra yeniden denenir (en fazla 3). Yazılan rapor tekrar yazılmaz.
