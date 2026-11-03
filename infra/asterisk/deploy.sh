#!/usr/bin/env bash
# Santralio: ortak Asterisk ayarlarını /etc/asterisk altına kurar.
# Kiracı dosyalarına (tenants/) dokunmaz; onları kontrol servisi üretir.
# Kullanım: sudo infra/asterisk/deploy.sh [--restart]
set -euo pipefail

SRC="$(cd "$(dirname "$0")/etc" && pwd)"
DST=/etc/asterisk
DOMAIN=sip.santralio.site

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }

# Paketle gelen ilk ayarların yedeği (bir kez alınır).
[ -e /etc/asterisk.dist ] || cp -a "$DST" /etc/asterisk.dist

for f in "$SRC"/*.conf; do
  install -m 0640 -o root -g asterisk "$f" "$DST/$(basename "$f")"
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
