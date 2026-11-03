#!/usr/bin/env bash
# Santralio: web panelini derler, /opt/santralio/web altına kurar ve Caddy'yi yeniden yükler.
# Kullanım: sudo infra/web-deploy.sh [--check]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_USER="${SUDO_USER:-root}"
# shellcheck source=lib/site.sh
. "$REPO/infra/lib/site.sh"

if [ "${1:-}" = "--check" ]; then
  if render "$REPO/infra/caddy/Caddyfile" | diff -q - /etc/caddy/Caddyfile >/dev/null 2>&1; then
    echo "Caddyfile: aynı."
  else
    echo "Caddyfile: farklı"
    render "$REPO/infra/caddy/Caddyfile" | diff -u /etc/caddy/Caddyfile - | head -30 || true
  fi
  exit 0
fi

# Derleme, depo sahibinin kullanıcısıyla yapılır (root olarak npm çalıştırılmaz).
sudo -u "$BUILD_USER" bash -c "cd '$REPO/web' && npm ci --no-fund --no-audit --silent && npm run --silent build"

install -d -m 0755 /opt/santralio/web
# Eski derlemenin dosyaları yeni sürümün yanında kalır (adları içerik özetli olduğu için çakışmaz).
cp -r "$REPO/web/dist/." /opt/santralio/web/
chown -R root:root /opt/santralio/web
chmod -R go-w,a+rX /opt/santralio/web

install -d -m 0755 /var/lib/santralio-acme
[ -e /etc/caddy/Caddyfile.dist ] || cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.dist
tmp=$(mktemp)
render "$REPO/infra/caddy/Caddyfile" >"$tmp"
caddy validate --config "$tmp" --adapter caddyfile >/dev/null 2>&1 || caddy validate --config "$tmp" --adapter caddyfile
install -m 0644 "$tmp" /etc/caddy/Caddyfile
rm -f "$tmp"
systemctl reload caddy
echo "Web paneli kuruldu: https://panel.$SANTRALIO_BASE_DOMAIN"
