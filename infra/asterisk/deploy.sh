#!/usr/bin/env bash
# Santralio: ortak Asterisk ayarlarını /etc/asterisk altına kurar.
# Kiracı dosyalarına (tenants/) dokunmaz; onları kontrol servisi üretir.
# Ayar dosyaları şablondur: /etc/santralio/site.env değerleriyle doldurulur (infra/lib/site.sh).
# Kullanım: sudo infra/asterisk/deploy.sh [--restart | --check]
#   --check : hiçbir şeyi değiştirmeden, üretilecek dosyaların kurulu olanlardan farkını gösterir.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/etc" && pwd)"
DST=/etc/asterisk

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
# shellcheck source=../lib/site.sh
. "$(dirname "$0")/../lib/site.sh"

if [ "${1:-}" = "--check" ]; then
  diffs=0
  for f in "$SRC"/*.conf; do
    if ! render "$f" | diff -q - "$DST/$(basename "$f")" >/dev/null 2>&1; then
      echo "farklı: $(basename "$f")"
      render "$f" | diff -u "$DST/$(basename "$f")" - | head -20 || true
      diffs=$((diffs + 1))
    fi
  done
  echo "Asterisk ayarları: $diffs dosya farklı."
  exit 0
fi

# Paketle gelen ilk ayarların yedeği (bir kez alınır).
[ -e /etc/asterisk.dist ] || cp -a "$DST" /etc/asterisk.dist

for f in "$SRC"/*.conf; do
  tmp=$(mktemp)
  render "$f" >"$tmp"
  install -m 0640 -o root -g asterisk "$tmp" "$DST/$(basename "$f")"
  rm -f "$tmp"
done

install -d -m 0750 -o root -g asterisk "$DST/manager.d"
# tenants/ kontrol servisinin kullanıcısına aittir (bkz. control/README.md).
if id santralio-ctl >/dev/null 2>&1; then
  install -d -m 2750 -o santralio-ctl -g asterisk "$DST/tenants"
else
  install -d -m 2750 -o root -g asterisk "$DST/tenants"
fi

# TLS sertifikası: Let's Encrypt'ten Asterisk'in okuyabileceği yere kopyalanır.
"$(dirname "$0")/cert-hook.sh" --no-restart

if [ "${1:-}" = "--restart" ]; then
  systemctl restart asterisk
else
  asterisk -rx 'core reload' >/dev/null
fi
echo "Asterisk ayarları kuruldu."
