#!/usr/bin/env bash
# Santralio: şifreli, sunucu dışına otomatik yedek (restic).
#
# Ne yedeklenir:
#   - PostgreSQL "santralio" veritabanı (pg_dump, özel biçim) ve roller
#   - Ana şifreleme anahtarları ve servis anahtarları (çözülmüş hâliyle; yedek deposu zaten şifreli).
#     Ana anahtar olmadan veritabanındaki hat ve ödeme bilgileri çözülemez; bu yüzden yedeğe girer.
#   - Arama kayıtları (/var/lib/santralio/recordings), kiracı anonsları, /etc/santralio
# Nereye: /etc/santralio/backup.env içindeki RESTIC_REPOSITORY (sftp:, s3:, rest:, b2: ya da yerel dizin).
# Yedek şifresi systemd-creds ile şifreli saklanır. Şifre kaybolursa yedek açılamaz: kurarken bir kopyasını
# şifre yöneticinize kaydedin. Sunucu tamamen giderse yedeği yalnızca bu şifre ve depo adresiyle açarsınız.
#
#   sudo infra/backup.sh init        depo adresini ve şifreyi sorar, depoyu oluşturur, zamanlayıcıyı açar
#   sudo infra/backup.sh run         şimdi yedek al (zamanlayıcı her gece 02:15 UTC çalıştırır)
#   sudo infra/backup.sh status      son yedeğin durumu
#   sudo infra/backup.sh list        anlık görüntüler
#   sudo infra/backup.sh check       depo bütünlüğü (verinin %5'ini okuyarak)
#   sudo infra/backup.sh restore [id]            görüntüyü /var/lib/santralio/restore-<zaman>/ altına açar (hiçbir şeyi ezmez)
#   sudo infra/backup.sh restore-apply <dizin>   açılmış yedeği canlıya uygular (servisleri durdurur; onay ister)
set -euo pipefail

CONF="${SANTRALIO_BACKUP_CONF:-/etc/santralio/backup.env}"
CREDS="${SANTRALIO_CREDS:-/etc/credstore.encrypted}"
STATUS="${SANTRALIO_BACKUP_STATUS:-/var/lib/santralio/backup-status.json}"
STAGE_ROOT="${SANTRALIO_BACKUP_STAGE:-/var/lib/santralio/backup-stage}"
DB="${SANTRALIO_PG_DATABASE:-santralio}"
PATHS=(/var/lib/santralio/recordings /var/lib/asterisk/sounds/santralio /etc/santralio)
KEEP=(--keep-daily 7 --keep-weekly 4 --keep-monthly 6)
TEST_MODE="${SANTRALIO_BACKUP_TEST:-}" # testte root/systemd/postgres sudo gerekmez

die() { echo "hata: $*" >&2; exit 1; }
[ -n "$TEST_MODE" ] || [ "$(id -u)" -eq 0 ] || die "root olarak çalıştırın"
command -v restic >/dev/null || die "restic kurulu değil (sudo apt install restic)"

as_postgres() { if [ -n "$TEST_MODE" ]; then "$@"; else sudo -u postgres "$@"; fi; }

password_cmd() {
  if [ -n "$TEST_MODE" ]; then echo "cat ${SANTRALIO_BACKUP_PASSWORD_FILE:?}"; else echo "systemd-creds decrypt --name=santralio-backup-password $CREDS/santralio-backup-password -"; fi
}

load_conf() {
  [ -f "$CONF" ] || die "yapılandırma yok: $CONF (önce: sudo infra/backup.sh init)"
  set -a
  # shellcheck disable=SC1090
  . "$CONF"
  set +a
  [ -n "${RESTIC_REPOSITORY:-}" ] || die "RESTIC_REPOSITORY tanımlı değil ($CONF)"
  [ -n "$TEST_MODE" ] || [ -e "$CREDS/santralio-backup-password" ] || die "yedek şifresi yok (önce: sudo infra/backup.sh init)"
  export RESTIC_PASSWORD_COMMAND
  RESTIC_PASSWORD_COMMAND="$(password_cmd)"
}

write_status() { # ok snapshot bytes duration message
  local tmp
  tmp="$(mktemp "$(dirname "$STATUS")/.backup-status.XXXXXX")"
  python3 - "$@" >"$tmp" <<'PY'
import json, sys, datetime
ok, snap, size, dur, msg = sys.argv[1:6]
print(json.dumps({
  "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "ok": ok == "1", "snapshot": snap or None, "bytes": int(size or 0), "durationS": int(dur or 0),
  "message": msg[:500] or None,
}))
PY
  chmod 0644 "$tmp"
  mv "$tmp" "$STATUS"
}

cmd_init() {
  [ -z "$TEST_MODE" ] || die "init testte kullanılmaz"
  install -d -m 0750 /etc/santralio
  if [ ! -f "$CONF" ]; then
    echo "Yedek deposu adresi. Örnekler:"
    echo "  sftp:u123456@u123456.your-storagebox.de:santralio    (Hetzner Storage Box, SSH anahtarı gerekir)"
    echo "  s3:https://s3.eu-central-1.amazonaws.com/kova/santralio"
    echo "  /mnt/yedek/santralio                                  (yerel disk; sunucu dışı değildir)"
    read -r -p "RESTIC_REPOSITORY: " repo
    [ -n "$repo" ] || die "adres boş"
    umask 077
    printf '# Santralio yedek ayarları (infra/backup.sh). S3 için AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY de buraya.\nRESTIC_REPOSITORY=%q\n' "$repo" >"$CONF"
    umask 022
    echo "yazıldı: $CONF"
  fi
  if [ ! -e "$CREDS/santralio-backup-password" ]; then
    echo "Yedek şifresi: en az 20 karakter. BUNU ŞİFRE YÖNETİCİNİZE KAYDEDİN; kaybolursa yedek açılamaz."
    read -r -s -p "Şifre: " p1; echo
    read -r -s -p "Tekrar: " p2; echo
    [ "$p1" = "$p2" ] || die "şifreler aynı değil"
    [ "${#p1}" -ge 20 ] || die "şifre en az 20 karakter olmalı"
    install -d -m 0700 "$CREDS"
    printf '%s' "$p1" | systemd-creds encrypt --name=santralio-backup-password - "$CREDS/santralio-backup-password"
    chmod 0600 "$CREDS/santralio-backup-password"
    unset p1 p2
  fi
  load_conf
  if restic cat config >/dev/null 2>&1; then echo "depo zaten var"; else restic init; fi
  local repo
  repo="$(cd "$(dirname "$0")/.." && pwd)"
  install -m 0644 "$repo/control/santralio-backup.service" "$repo/control/santralio-backup.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --quiet --now santralio-backup.timer
  echo "Hazır. İlk yedek için: sudo infra/backup.sh run"
}

cmd_run() {
  load_conf
  local start stage snap size msg
  start=$(date +%s)
  install -d -m 0700 "$STAGE_ROOT"
  stage="$(mktemp -d "$STAGE_ROOT/run.XXXXXX")"
  CLEANUP="$stage"
  trap 'rm -rf -- "${CLEANUP:-/nonexistent}"' EXIT
  chmod 0700 "$stage"
  if ! {
    as_postgres pg_dump -Fc --no-owner "$DB" >"$stage/santralio.dump" &&
      as_postgres pg_dumpall --globals-only --no-role-passwords >"$stage/globals.sql" &&
      dump_keys "$stage/keys" &&
      {
        local inc=("$stage")
        for p in "${PATHS[@]}"; do [ -e "$p" ] && inc+=("$p"); done
        restic backup --quiet --tag santralio --host santralio --json "${inc[@]}" >"$stage/restic.json"
      }
  } 2>"$stage/err"; then
    msg="$(tail -c 400 "$stage/err" | tr '\n' ' ')"
    write_status 0 "" 0 $(($(date +%s) - start)) "$msg"
    die "yedek alınamadı: $msg"
  fi
  snap="$(python3 -c 'import json,sys; s=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; d=[x for x in s if x.get("message_type")=="summary"]; print(d[-1]["snapshot_id"][:8] if d else "")' "$stage/restic.json")"
  size="$(python3 -c 'import json,sys; s=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; d=[x for x in s if x.get("message_type")=="summary"]; print(d[-1].get("total_bytes_processed",0) if d else 0)' "$stage/restic.json")"
  restic forget --quiet --tag santralio "${KEEP[@]}" --prune >/dev/null 2>"$stage/err" || echo "uyarı: eski görüntüler temizlenemedi: $(cat "$stage/err")" >&2
  write_status 1 "$snap" "$size" $(($(date +%s) - start)) ""
  echo "yedek tamam: $snap ($(numfmt --to=iec "$size" 2>/dev/null || echo "$size bayt"))"
}

# Anahtarlar: credstore'daki her şey çözülüp dosyaya yazılır (yalnızca yedek dizininde, 0600).
dump_keys() {
  local out=$1
  install -d -m 0700 "$out"
  if [ -n "$TEST_MODE" ]; then
    [ -d "${SANTRALIO_BACKUP_TEST_KEYS:-}" ] && cp -p "$SANTRALIO_BACKUP_TEST_KEYS"/* "$out/" 2>/dev/null
    return 0
  fi
  local f name
  for f in "$CREDS"/santralio-*; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    [ "$name" = "santralio-backup-password" ] && continue
    systemd-creds decrypt --name="$name" "$f" - >"$out/$name"
    chmod 0600 "$out/$name"
  done
}

cmd_status() {
  if [ -f "$STATUS" ]; then cat "$STATUS"; echo; else echo "henüz yedek alınmadı"; fi
}

cmd_list() { load_conf; restic snapshots --tag santralio; }
cmd_check() { load_conf; restic check --read-data-subset=5%; }

cmd_restore() {
  load_conf
  local id="${1:-latest}" dest
  dest="/var/lib/santralio/restore-$(date -u +%Y%m%dT%H%M%SZ)"
  [ -z "$TEST_MODE" ] || dest="${SANTRALIO_BACKUP_RESTORE_DIR:?}/restore"
  install -d -m 0700 "$dest"
  restic restore "$id" --tag santralio --target "$dest"
  echo "açıldı: $dest"
  echo "İçerik: veritabanı dökümü, anahtarlar, kayıtlar. Canlıya uygulamak için: sudo infra/backup.sh restore-apply $dest"
}

cmd_restore_apply() {
  [ -z "$TEST_MODE" ] || die "restore-apply testte kullanılmaz"
  local dir="${1:?dizin}" stage
  stage="$(find "$dir" -maxdepth 6 -type d -path '*/backup-stage/run.*' | head -1)"
  [ -n "$stage" ] && [ -f "$stage/santralio.dump" ] || die "$dir içinde veritabanı dökümü yok"
  echo "DİKKAT: canlı veritabanı, anahtarlar ve kayıtlar bu yedekle DEĞİŞTİRİLECEK. Santral ve paneller birkaç dakika duracak."
  read -r -p "Devam etmek için 'GERI YUKLE' yazın: " ok
  [ "$ok" = "GERI YUKLE" ] || die "vazgeçildi"
  systemctl stop santralio-api santralio-ai asterisk
  # Anahtarlar: bu sunucunun anahtarıyla yeniden şifrelenir.
  local f
  for f in "$stage"/keys/santralio-*; do
    [ -e "$f" ] || continue
    systemd-creds encrypt --name="$(basename "$f")" "$f" "$CREDS/$(basename "$f")"
    chmod 0600 "$CREDS/$(basename "$f")"
  done
  sudo -u postgres dropdb --if-exists "$DB"
  sudo -u postgres createdb -O santralio-ctl "$DB"
  sudo -u postgres pg_restore --no-owner --role=santralio-ctl -d "$DB" "$stage/santralio.dump"
  for p in /var/lib/santralio/recordings /var/lib/asterisk/sounds/santralio; do
    [ -d "$dir$p" ] && rsync -a "$dir$p/" "$p/"
  done
  systemctl start asterisk santralio-api santralio-ai
  echo "Geri yükleme tamam. Ardından: sudo control/install.sh (izinler ve santral ayarları yeniden üretilir)."
}

case "${1:-}" in
  init) cmd_init ;;
  run) cmd_run ;;
  status) cmd_status ;;
  list) cmd_list ;;
  check) cmd_check ;;
  restore) cmd_restore "${2:-}" ;;
  restore-apply) cmd_restore_apply "${2:-}" ;;
  *) echo "kullanım: $0 init | run | status | list | check | restore [id] | restore-apply <dizin>" >&2; exit 1 ;;
esac
