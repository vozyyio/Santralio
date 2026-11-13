# Kaçan çağrıya otomatik yapay zekâ geri araması

Gelen çağrı kuyrukta **kapatılırsa** (ABANDON), **bekleme süresi dolarsa** (EXITWITHTIMEOUT) ya da **müsait temsilci yoksa**
(SANTRALIO_NOAGENT), birkaç saniye içinde yapay zekâ asistanı arayanı kiracının hattından geri arar.

## Akış

1. Kontrol servisi (API süreci) 15 saniyede bir `callbacks.tick()` çalıştırır.
2. `queue_log`'dan son `max_age_minutes` içindeki kaçan gelen çağrılar okunur, `callback_jobs`'a yazılır (aynı callid bir kez).
3. Gecikme (`delay_s`) dolunca, izinli saat/gün aralığındaysa AMI `Originate`:
   `PJSIP/<0XXXXXXXXXX>@tN_trunk` → açılınca `tN-callback,s,1` (değişken `CB=<iş>_<numara>`).
4. `tN-callback` kanal sınırını uygular, arayan numarasını ve `SANTRALIO_AI_KIND=callback:<iş>`'i ayarlar, `tN-ai-<akış>`'a gider.
5. Yapay zekâ servisi bunu görür: karşılama "Az önce bizi aramışsınız…" (yapay zekâ olduğunu söyler), talimatın önüne geri arama kuralları eklenir, iş `answered` olur.
6. Çaldırma + 60 sn içinde oturum başlamazsa tekrar sıraya (`retry_minutes`), en fazla `max_attempts`; sonra `no_answer`.

## Kurallar

- Gizli/geçersiz numara aranmaz. Türkiye'de yalnızca sabit (2-4xx) ve cep (5xx); 0850/444/0900 aranmaz. Yurt dışı ayarla açılır.
- Aynı numara `cooldown_hours` içinde bir kez; "aranmak istemeyenler" listesi; arayan bu arada cevaplanmış bir görüşme yaptıysa (gelen ya da giden) `resolved`.
- Eş zamanlı geri arama sınırı ve lisans kanal sınırı (`group show channels`); saat/gün aralığı dışında arama yok; `max_age_minutes`'tan eski kaçanlar düşer.
- Yapay zekâ ve dış arama lisans modülleri, açık bir trunk ve açık bir yapay zekâ akışı gerekir.

## Bilinen eksikler

- Yapay zekâ "beni aramayın" dediğinde numara listeye otomatik eklenmiyor (şimdilik panelden).
- Web formu gibi dış kaynaklı aday aramaları yok (İYS/izin gerektirir).
- Gerçek operatör hattıyla test edilmedi; ilk denemede `Originate` numara biçimi (0XXXXXXXXXX) operatöre göre doğrulanmalı.
