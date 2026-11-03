#!/usr/bin/env bash
# Santralio: tek komutla kurulum. Boş bir Ubuntu 26.04 sunucusunda bütün bileşenleri kurar; kurulu sunucuda
# tekrar çalıştırılabilir (eksikleri tamamlar, ayarları günceller, çalışan sistemi bozmaz).
#
# Kullanım (depo sunucuya kopyalandıktan ya da klonlandıktan sonra, root olarak):
#   sudo infra/install-all.sh --domain ornek.com --ip 203.0.113.10 [--sip-host sip.ornek.com] [--no-cloudflare] [--email ops@ornek.com]
#   sudo infra/install-all.sh                 # /etc/santralio/site.env zaten varsa onunla
#   sudo infra/install-all.sh --restart       # sonunda Asterisk'i yeniden başlat (görüşmeler biterken)
#
# Ön koşullar (betik denetler):
#   - DNS: <sip-host> proxy'siz A kaydıyla sunucunun IP'sini gösterir; panel/crm/agent.<alan> sunucuya (ya da Cloudflare'e) çözülür.
#   - Sunucunun genel IPv4 adresi arayüzde doğrudan bulunur (NAT arkası desteklenmez).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SITE_ENV=/etc/santralio/site.env

# Sabitlenmiş indirmeler (sürüm ve SHA-256). Yeni sürüme geçerken ikisi birlikte güncellenir.
PIPER_RELEASE=2023.11.14-2
declare -A PIPER_SHA256=(
  [aarch64]=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
  [x86_64]=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
)
VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/tr/tr_TR/dfki/medium
VOICE_MODEL=tr_TR-dfki-medium
VOICE_ONNX_SHA256=2844717f524ab965d3fe86e60562cbb601d3e456836efcc2196cc3a14112a8fb
VOICE_JSON_SHA256=13ebd7810f1b61b5027583cf3131a0a233b6ea81c38f2200ebc4ff41c3cca039

PACKAGES=(
  asterisk asterisk-modules asterisk-core-sounds-en-wav asterisk-moh-opsound-wav
  postgresql caddy certbot
  sox ffmpeg espeak-ng mbrola-tr2
  ufw fail2ban curl ca-certificates dnsutils
)

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'UYARI: %s\n' "$*" >&2; }
die() {
  printf 'HATA: %s\n' "$*" >&2
  exit 1
}

# --- Seçenekler ---
DOMAIN="" IP="" SIP_HOST="" CLOUDFLARE="" EMAIL="" RESTART=no
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --ip) IP=$2; shift 2 ;;
    --sip-host) SIP_HOST=$2; shift 2 ;;
    --no-cloudflare) CLOUDFLARE=no; shift ;;
    --cloudflare) CLOUDFLARE=yes; shift ;;
    --email) EMAIL=$2; shift 2 ;;
    --restart) RESTART=yes; shift ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "bilinmeyen seçenek: $1 (yardım: --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "root olarak çalıştırın"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "yalnızca Ubuntu desteklenir (bulunan: ${PRETTY_NAME:-?})"
[ "${VERSION_ID:-}" = 26.04 ] || warn "Ubuntu 26.04 için hazırlandı; bulunan $VERSION_ID. Paket sürümleri farklı olabilir."
ARCH=$(uname -m)
[ -n "${PIPER_SHA256[$ARCH]:-}" ] || die "desteklenmeyen işlemci mimarisi: $ARCH (aarch64, x86_64)"

# --- 1. Sunucu ayarları ---
step "Sunucu ayarları ($SITE_ENV)"
install -d -m 0755 /etc/santralio
if [ -n "$DOMAIN$IP$SIP_HOST$CLOUDFLARE$EMAIL" ]; then
  if [ -r "$SITE_ENV" ]; then
    # shellcheck disable=SC1090
    . "$SITE_ENV"
    cp -a "$SITE_ENV" "$SITE_ENV.bak-$(date +%Y%m%d%H%M%S)"
  fi
  DOMAIN=${DOMAIN:-${SANTRALIO_BASE_DOMAIN:-}}
  IP=${IP:-${SANTRALIO_PUBLIC_IP:-}}
  [ -n "$DOMAIN" ] && [ -n "$IP" ] || die "ilk kurulumda --domain ve --ip gerekli"
  [[ $DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "geçersiz alan adı: $DOMAIN"
  [[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "geçersiz IPv4: $IP"
  cat >"$SITE_ENV" <<CONF
# Santralio sunucu ayarları (bkz. infra/site.env.example). install-all.sh oluşturdu: $(date -u +%F)
SANTRALIO_BASE_DOMAIN=$DOMAIN
SANTRALIO_SIP_HOST=${SIP_HOST:-${SANTRALIO_SIP_HOST:-sip.$DOMAIN}}
SANTRALIO_PUBLIC_IP=$IP
SANTRALIO_CLOUDFLARE=${CLOUDFLARE:-${SANTRALIO_CLOUDFLARE:-yes}}
SANTRALIO_ACME_EMAIL=${EMAIL:-${SANTRALIO_ACME_EMAIL:-}}
CONF
  chmod 0644 "$SITE_ENV"
fi
[ -r "$SITE_ENV" ] || die "$SITE_ENV yok; ilk kurulumda --domain ve --ip verin"
# shellcheck source=lib/site.sh
. "$REPO/infra/lib/site.sh"
echo "alan: $SANTRALIO_BASE_DOMAIN · SIP: $SANTRALIO_SIP_HOST · IP: $SANTRALIO_PUBLIC_IP · Cloudflare: $SANTRALIO_CLOUDFLARE"
ip -4 -o addr show | grep -qw "$SANTRALIO_PUBLIC_IP" || die "$SANTRALIO_PUBLIC_IP bu sunucunun arayüzlerinde yok (NAT arkası desteklenmez)"

# --- 2. Paketler ---
step "Paketler"
export DEBIAN_FRONTEND=noninteractive
FIRST_ASTERISK=no
dpkg -s asterisk >/dev/null 2>&1 || FIRST_ASTERISK=yes
apt-get update -qq
# --no-upgrade: kurulu paketler burada yükseltilmez (çalışan santral görüşme ortasında güncellenmesin);
# güncellemeleri unattended-upgrades yapar.
apt-get install -y -qq --no-upgrade "${PACKAGES[@]}" >/dev/null
# Node.js: yoksa Ubuntu deposundan (26.04'te 22.22). Başka kaynaktan (ör. NodeSource) kuruluysa ona dokunulmaz;
# NodeSource paketi npm'i içinde taşır, Ubuntu'nun npm paketi onunla çakışır.
command -v node >/dev/null || apt-get install -y -qq --no-upgrade nodejs >/dev/null
command -v npm >/dev/null || apt-get install -y -qq --no-upgrade npm >/dev/null
node_ver=$(node -p 'process.versions.node')
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' ||
  die "Node.js $node_ver eski; en az 22.18 gerekli (TypeScript dosyaları derlemeden çalışır)"
echo "Asterisk $(asterisk -V | awk '{print $2}') · PostgreSQL $(psql --version | awk '{print $3}') · Node $node_ver · Caddy $(caddy version | awk '{print $1}')"

# --- 3. DNS ---
step "DNS"
sip_ip=$(dig +short A "$SANTRALIO_SIP_HOST" @1.1.1.1 | tail -1)
[ "$sip_ip" = "$SANTRALIO_PUBLIC_IP" ] ||
  die "$SANTRALIO_SIP_HOST -> '${sip_ip:-yok}', beklenen $SANTRALIO_PUBLIC_IP. Kaydı proxy'siz (Cloudflare'de gri bulut) açın."
for h in panel crm agent; do
  [ -n "$(dig +short A "$h.$SANTRALIO_BASE_DOMAIN" @1.1.1.1)" ] || warn "$h.$SANTRALIO_BASE_DOMAIN çözülmüyor; o adresin sertifikası alınamaz."
done
echo "tamam"

# --- 4. Swap (8 GB'tan az bellekte, yoksa 2 GB) ---
step "Swap"
if [ -z "$(swapon --show --noheadings)" ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 8000000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo 'vm.swappiness=10' >/etc/sysctl.d/90-santralio-swap.conf && sysctl -q -p /etc/sysctl.d/90-santralio-swap.conf
  echo "2 GB swap açıldı"
else
  echo "gerekmiyor"
fi

# --- 5. Güvenlik duvarı ---
# SSH izni her şeyden önce verilir; mevcut kurallar silinmez. 5060, operatör IP'leri eklenince açılır (infra/firewall-sync.sh).
step "Güvenlik duvarı (ufw) ve fail2ban"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp comment 'Santralio HTTP (sertifika)' >/dev/null
ufw allow 443/tcp comment 'Santralio HTTPS (panel, crm, agent)' >/dev/null
ufw allow 5061/tcp comment 'Santralio SIP TLS (temsilci)' >/dev/null
ufw allow 10000:19999/udp comment 'Santralio RTP' >/dev/null
ufw status | grep -q '^Status: active' || ufw --force enable >/dev/null
install -m 0644 "$REPO/infra/fail2ban/santralio-asterisk.conf" /etc/fail2ban/jail.d/santralio-asterisk.conf
systemctl reload-or-restart fail2ban
ufw status | grep -E 'OpenSSH|443|5061|10000' | head -4

# --- 6. Anons sesi (Piper, yerel) ---
step "Piper ve Türkçe ses modeli"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
install -d -m 0755 /opt/santralio /opt/santralio/voices
if [ ! -x /opt/santralio/piper/piper ]; then
  curl -fsSL -o "$work/piper.tgz" "https://github.com/rhasspy/piper/releases/download/$PIPER_RELEASE/piper_linux_$ARCH.tar.gz"
  echo "${PIPER_SHA256[$ARCH]}  $work/piper.tgz" | sha256sum -c --quiet || die "Piper paketinin SHA-256 değeri tutmuyor"
  tar xzf "$work/piper.tgz" -C /opt/santralio/ --no-same-owner
  chown -R root:root /opt/santralio/piper && chmod -R go-w /opt/santralio/piper
  echo "Piper $PIPER_RELEASE kuruldu"
fi
if [ ! -s "/opt/santralio/voices/$VOICE_MODEL.onnx" ]; then
  curl -fsSL -o "$work/v.onnx" "$VOICE_URL/$VOICE_MODEL.onnx"
  curl -fsSL -o "$work/v.json" "$VOICE_URL/$VOICE_MODEL.onnx.json"
  echo "$VOICE_ONNX_SHA256  $work/v.onnx" | sha256sum -c --quiet || die "ses modelinin SHA-256 değeri tutmuyor"
  echo "$VOICE_JSON_SHA256  $work/v.json" | sha256sum -c --quiet || die "ses modeli ayarının SHA-256 değeri tutmuyor"
  install -m 0644 "$work/v.onnx" "/opt/santralio/voices/$VOICE_MODEL.onnx"
  install -m 0644 "$work/v.json" "/opt/santralio/voices/$VOICE_MODEL.onnx.json"
  echo "ses modeli $VOICE_MODEL kuruldu"
fi
echo 'Santralio sesi.' | /opt/santralio/piper/piper --model "/opt/santralio/voices/$VOICE_MODEL.onnx" --output_raw >"$work/test.raw" 2>/dev/null || true
[ "$(stat -c %s "$work/test.raw")" -gt 1000 ] || die "Piper çalışmıyor"
echo "Piper çalışıyor"

# --- 7. Web paneli ve Caddy (panel/crm/agent sertifikalarını Caddy kendisi alır) ---
step "Web paneli ve Caddy"
"$REPO/infra/web-deploy.sh"

# --- 8. SIP sertifikası (certbot, webroot; 80 portu Caddy'de) ---
step "SIP sertifikası ($SANTRALIO_SIP_HOST)"
if [ ! -s "/etc/letsencrypt/live/$SANTRALIO_SIP_HOST/fullchain.pem" ]; then
  if [ -n "$SANTRALIO_ACME_EMAIL" ]; then acme=(--email "$SANTRALIO_ACME_EMAIL"); else acme=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w /var/lib/santralio-acme -d "$SANTRALIO_SIP_HOST" --non-interactive --agree-tos --key-type ecdsa "${acme[@]}" >/dev/null
  echo "sertifika alındı"
else
  echo "var"
fi
install -m 0755 "$REPO/infra/asterisk/cert-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/santralio-asterisk.sh

# --- 9. Asterisk ---
step "Asterisk"
if [ "$FIRST_ASTERISK" = yes ] || [ "$RESTART" = yes ]; then
  "$REPO/infra/asterisk/deploy.sh" --restart
  sleep 5
else
  "$REPO/infra/asterisk/deploy.sh"
fi

# --- 10. Kontrol servisi (veritabanı, şifreleme anahtarı, API, CLI, migration'lar) ---
step "Kontrol servisi"
"$REPO/control/install.sh"
/usr/local/bin/santralio apply >/dev/null
git -C "$REPO" rev-parse --short HEAD 2>/dev/null >/etc/santralio/version || echo "bilinmiyor" >/etc/santralio/version

# --- 11. Sağlık kontrolü ---
step "Sağlık kontrolü"
fail=0
for s in asterisk postgresql caddy santralio-api fail2ban; do
  if systemctl is-active --quiet "$s"; then echo "  çalışıyor : $s"; else echo "  DURDU     : $s"; fail=1; fi
done
tls=$(asterisk -rx 'pjsip show transports' | grep -c 'transport-tls' || true)
[ "$tls" -ge 1 ] && echo "  çalışıyor : SIP TLS (5061)" || { echo "  YOK       : SIP TLS"; fail=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://panel.$SANTRALIO_BASE_DOMAIN/api/me" || true)
[ "$code" = 401 ] && echo "  çalışıyor : https://panel.$SANTRALIO_BASE_DOMAIN (API)" || { echo "  YANIT YOK : https://panel.$SANTRALIO_BASE_DOMAIN/api/me ($code)"; fail=1; }
echo "  sürüm     : $(cat /etc/santralio/version)"

if [ "$fail" -ne 0 ]; then
  warn "kurulum tamamlandı ama bazı kontroller geçmedi (yukarıda)."
  exit 1
fi

cat <<NEXT

Kurulum tamam. Sıradaki adımlar:
  1. Platform yöneticisi:  santralio user add <e-posta> --role platform_admin --name "Ad Soyad"
  2. Müşteri:              santralio tenant create "Müşteri adı"   (öneki yazar: t<id>)
                           santralio license set-manual t<id> --max-ext 10 --max-channels 4
  3. Panel:                https://panel.$SANTRALIO_BASE_DOMAIN  (numara, operatör hattı, menü, personel)
     Operatör hattı:       santralio trunk set t<id> --operator netgsm --server <sunucu> --username <kullanıcı>
     Operatör IP'leri:     santralio operator ip add netgsm <cidr> && sudo infra/firewall-sync.sh
NEXT
