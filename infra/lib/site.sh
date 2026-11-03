# Santralio: sunucu ayarlarını yükler ve şablonları doldurur. Kurulum betikleri "source" eder.
# Ayar dosyası: /etc/santralio/site.env (install-all.sh oluşturur). Örnek: infra/site.env.example
#
# Şablonlarda @SANTRALIO_<AD>@ biçimindeki yer tutucular bu değerlerle değiştirilir.

SITE_ENV=${SANTRALIO_SITE_ENV:-/etc/santralio/site.env}
# shellcheck disable=SC1090
[ -r "$SITE_ENV" ] && . "$SITE_ENV"

: "${SANTRALIO_BASE_DOMAIN:?SANTRALIO_BASE_DOMAIN tanımlı değil ($SITE_ENV)}"
: "${SANTRALIO_SIP_HOST:=sip.$SANTRALIO_BASE_DOMAIN}"
: "${SANTRALIO_PUBLIC_IP:?SANTRALIO_PUBLIC_IP tanımlı değil ($SITE_ENV)}"
: "${SANTRALIO_CLOUDFLARE:=yes}"
: "${SANTRALIO_ACME_EMAIL:=}"

SANTRALIO_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Panel adresleri Cloudflare proxy'si arkasındaysa yalnızca Cloudflare IP'lerinden gelen bağlantı kabul edilir
# ve gerçek istemci IP'si CF-Connecting-IP başlığından alınır. Değilse herkes kabul edilir, IP bağlantıdan alınır.
if [ "$SANTRALIO_CLOUDFLARE" = "yes" ]; then
  SANTRALIO_CADDY_NOT_ALLOWED="not remote_ip $(grep -E '^[0-9a-f.:/]+$' "$SANTRALIO_REPO/infra/caddy/cloudflare-ips.txt" | tr '\n' ' ' | sed 's/ *$//')"
  SANTRALIO_CADDY_CLIENT_IP="{http.request.header.CF-Connecting-IP}"
else
  # "her şey değil" hiçbir zaman eşleşmez: reddedilen bağlantı yok.
  SANTRALIO_CADDY_NOT_ALLOWED="not remote_ip 0.0.0.0/0 ::/0"
  SANTRALIO_CADDY_CLIENT_IP="{remote_host}"
fi

# render <şablon> : yer tutucuları doldurup standart çıktıya yazar. Doldurulmamış yer tutucu kalırsa hata verir.
render() {
  local out
  out=$(sed \
    -e "s|@SANTRALIO_BASE_DOMAIN@|$SANTRALIO_BASE_DOMAIN|g" \
    -e "s|@SANTRALIO_SIP_HOST@|$SANTRALIO_SIP_HOST|g" \
    -e "s|@SANTRALIO_PUBLIC_IP@|$SANTRALIO_PUBLIC_IP|g" \
    -e "s|@SANTRALIO_CADDY_NOT_ALLOWED@|$SANTRALIO_CADDY_NOT_ALLOWED|g" \
    -e "s|@SANTRALIO_CADDY_CLIENT_IP@|$SANTRALIO_CADDY_CLIENT_IP|g" \
    "$1")
  if grep -q '@SANTRALIO_[A-Z_]*@' <<<"$out"; then
    echo "doldurulmamış yer tutucu: $1: $(grep -o '@SANTRALIO_[A-Z_]*@' <<<"$out" | sort -u | tr '\n' ' ' | sed 's/ *$//')" >&2
    return 1
  fi
  printf '%s\n' "$out"
}
