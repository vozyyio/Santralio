# Yedek ve geri yükleme

Santralio'nun yedeği `restic` ile alınır: şifreli, tekrarlanan veriyi bir kez saklayan, hedeften bağımsız (SFTP, S3, Backblaze B2, rest-server ya da yerel disk).

## Kurulum (bir kez)

```
sudo infra/backup.sh init
```

- Depo adresini sorar ve `/etc/santralio/backup.env` dosyasına yazar. Önerilen hedef Hetzner Storage Box: `sftp:u123456@u123456.your-storagebox.de:santralio`. Önce sunucunun SSH anahtarını Storage Box'a ekleyin ve root olarak bir kez bağlanıp doğrulayın. S3 için `AWS_ACCESS_KEY_ID` ve `AWS_SECRET_ACCESS_KEY` aynı dosyaya eklenir.
- Yedek şifresini sorar (en az 20 karakter) ve systemd-creds ile şifreli saklar. **Bu şifrenin bir kopyasını şifre yöneticinize kaydedin.** Sunucu tamamen giderse yedek yalnızca depo adresi ve bu şifreyle açılır.
- Depoyu oluşturur, gece zamanlayıcısını (02:15 UTC) açar. İlk yedek: `sudo infra/backup.sh run`.

## Ne yedeklenir

| İçerik | Neden |
| --- | --- |
| PostgreSQL `santralio` (pg_dump) ve roller | Kiracılar, ayarlar, CRM, ödeme talepleri, geçmiş |
| Ana şifreleme anahtarı ve servis anahtarları (çözülmüş) | Veritabanındaki hat ve ödeme bilgileri ana anahtar olmadan çözülemez. Depo şifreli olduğu için anahtarlar açıkta durmaz. |
| `/var/lib/santralio/recordings` | Arama kayıtları |
| `/var/lib/asterisk/sounds/santralio` | Kiracı anonsları |
| `/etc/santralio` | Site ve yedek ayarları |

Saklama: son 7 gün, 4 hafta, 6 ay. Panel → Sistem'de son yedeğin zamanı ve durumu görünür; 36 saatten eskiyse ya da başarısızsa kart kırmızı olur.

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| `sudo infra/backup.sh run` | Şimdi yedek al |
| `sudo infra/backup.sh status` | Son yedeğin durumu |
| `sudo infra/backup.sh list` | Görüntüler |
| `sudo infra/backup.sh check` | Depo bütünlüğü (verinin %5'i okunur) |
| `sudo infra/backup.sh restore [id]` | Görüntüyü `/var/lib/santralio/restore-<zaman>/` altına açar, hiçbir şeyi ezmez |
| `sudo infra/backup.sh restore-apply <dizin>` | Açılmış yedeği canlıya uygular: servisler durur, anahtarlar bu sunucunun anahtarıyla yeniden şifrelenir, veritabanı ve kayıtlar geri yazılır. "GERI YUKLE" yazarak onay ister. |

## Yeni sunucuya taşıma / felaket

1. Yeni sunucuda repoyu kurun (`infra/install-all.sh`, `control/install.sh`).
2. `sudo infra/backup.sh init` ile aynı depo adresi ve şifreyi girin (depo zaten var, yeniden oluşturulmaz).
3. `sudo infra/backup.sh restore` → `sudo infra/backup.sh restore-apply <açılan dizin>` → `sudo control/install.sh`.

Geri yüklemeyi gerçek bir felaketten önce en az bir kez denemek gerekir (test planı J4).
