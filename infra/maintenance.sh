#!/usr/bin/env bash
# Santralio: tanıtım sitesini (santralio.site: ana sayfa, /basvuru, /odeme) bakım moduna alır veya çıkarır.
# Bakımdayken Caddy bakim.html sayfasını 503 ve Retry-After ile sunar. Panel, API ve santral etkilenmez.
# Bayrak dosyası: /opt/santralio/maintenance.on (Caddy her istekte bakar; yeniden yükleme gerekmez).
#   sudo infra/maintenance.sh true     bakım modunu aç   (on da olur)
#   sudo infra/maintenance.sh false    bakım modunu kapat (off da olur)
#   infra/maintenance.sh status        durumu göster
set -euo pipefail
FLAG="${SANTRALIO_MAINTENANCE_FLAG:-/opt/santralio/maintenance.on}"
PAGE="$(dirname "$FLAG")/site/bakim.html"
NEED_ROOT="${SANTRALIO_MAINTENANCE_NO_ROOT:-}"

status() {
  if [ -e "$FLAG" ]; then echo "bakım modu: AÇIK (true)"; else echo "bakım modu: KAPALI (false)"; fi
}
need_root() {
  [ -n "$NEED_ROOT" ] || [ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
}

case "${1:-status}" in
  true|on)
    need_root
    [ -f "$PAGE" ] || { echo "bakım sayfası yok: $PAGE (önce: sudo infra/site-deploy.sh)" >&2; exit 1; }
    install -m 0644 /dev/null "$FLAG"
    status ;;
  false|off)
    need_root
    rm -f -- "$FLAG"
    status ;;
  status) status ;;
  *) echo "kullanım: $0 true | false | status" >&2; exit 1 ;;
esac
