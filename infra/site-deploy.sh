#!/usr/bin/env bash
# Santralio: tanıtım sitesini (santralio.site: ana sayfa, /basvuru, /odeme) derleyip /opt/santralio/site'a kurar.
# Turnstile site anahtarı /etc/santralio/site.env'den (TURNSTILE_SITE_KEY) okunur.
#   sudo infra/site-deploy.sh           derle ve kur
#   sudo infra/site-deploy.sh --check   yalnızca derle, kurulu sürümle karşılaştır
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
[ -r /etc/santralio/site.env ] && . /etc/santralio/site.env
set +a
OWNER="$(stat -c %U "$REPO")"
cd "$REPO/site"
sudo -u "$OWNER" npm ci --no-audit --no-fund --silent
sudo -u "$OWNER" env TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-}" VOZYY_API_BASE="${VOZYY_API_BASE:-}" npm run --silent build
if [ "${1:-}" = "--check" ]; then
  diff -rq "$REPO/site/dist" /opt/santralio/site && echo "site: aynı." || true
  exit 0
fi
install -d -m 0755 /opt/santralio/site /opt/santralio/site/assets
for f in "$REPO"/site/dist/*.html; do install -m 0644 "$f" /opt/santralio/site/; done
for f in "$REPO"/site/dist/assets/*; do install -m 0644 "$f" /opt/santralio/site/assets/; done
echo "Site kuruldu: https://${SANTRALIO_BASE_DOMAIN:-santralio.site}"
