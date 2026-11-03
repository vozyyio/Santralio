#!/usr/bin/env bash
# Santralio: web panelini derler, /opt/santralio/web altına kurar ve Caddy'yi yeniden yükler.
# Kullanım: sudo infra/web-deploy.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_USER="${SUDO_USER:-root}"

# Derleme, depo sahibinin kullanıcısıyla yapılır (root olarak npm çalıştırılmaz).
sudo -u "$BUILD_USER" bash -c "cd '$REPO/web' && npm ci --no-fund --no-audit --silent && npm run --silent build"

install -d -m 0755 /opt/santralio/web
# Eski derlemenin dosyaları yeni sürümün yanında kalır (adları içerik özetli olduğu için çakışmaz).
cp -r "$REPO/web/dist/." /opt/santralio/web/
chown -R root:root /opt/santralio/web
chmod -R go-w,a+rX /opt/santralio/web

install -d -m 0755 /var/lib/santralio-acme
[ -e /etc/caddy/Caddyfile.dist ] || cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.dist
install -m 0644 "$REPO/infra/caddy/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
echo "Web paneli kuruldu: https://panel.santralio.site"
