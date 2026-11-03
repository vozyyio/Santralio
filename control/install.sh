#!/usr/bin/env bash
# Santralio: kontrol servisini sunucuya kurar. Tekrar çalıştırılabilir; var olanı ezmez.
# - santralio-ctl sistem kullanıcısı ve PostgreSQL rolü/veritabanı (peer kimlik doğrulama)
# - Ana anahtar ve AMI şifresi: systemd-creds ile şifreli, /etc/credstore.encrypted/ altında
# - AMI kullanıcısı: /etc/asterisk/manager.d/santralio-ctl.conf
# - Kod: /opt/santralio/control, CLI: /usr/local/bin/santralio
# - Yönetim API'si: santralio-api.service (127.0.0.1:8090)
# Kullanım: sudo control/install.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/santralio/control
CREDS=/etc/credstore.encrypted
USER_NAME=santralio-ctl

# 1. Kullanıcı
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin \
    --user-group --groups asterisk "$USER_NAME"
fi

# 2. Veritabanı
cd /
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$USER_NAME'" | grep -q 1; then
  sudo -u postgres psql -qc "CREATE ROLE \"$USER_NAME\" LOGIN"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'santralio'" | grep -q 1; then
  sudo -u postgres createdb -O "$USER_NAME" santralio
fi

# 3. Gizli bilgiler (yalnızca yoksa üretilir; var olan anahtar asla değiştirilmez)
install -d -m 0700 "$CREDS"
new_cred() {
  local name=$1 value=$2
  [ -e "$CREDS/$name" ] && return 0
  printf '%s' "$value" | systemd-creds encrypt --name="$name" - "$CREDS/$name"
  chmod 0600 "$CREDS/$name"
  echo "üretildi: $CREDS/$name"
}
new_cred santralio-master-key-k1 "$(head -c 32 /dev/urandom | base64 -w0)"
new_cred santralio-ami-secret "$(head -c 24 /dev/urandom | base64 -w0 | tr -d '/+=')"

# 4. AMI kullanıcısı: şifre credential'dan okunur, Asterisk'in okuyacağı dosyaya yazılır.
AMI_SECRET="$(systemd-creds decrypt --name=santralio-ami-secret "$CREDS/santralio-ami-secret" -)"
umask 027
cat > /etc/asterisk/manager.d/santralio-ctl.conf.tmp <<CONF
; Santralio kontrol servisi. control/install.sh üretir.
[santralio-ctl]
secret = $AMI_SECRET
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,command
write = system,command
CONF
chown root:asterisk /etc/asterisk/manager.d/santralio-ctl.conf.tmp
mv /etc/asterisk/manager.d/santralio-ctl.conf.tmp /etc/asterisk/manager.d/santralio-ctl.conf
unset AMI_SECRET
umask 022

# 5. Kod
install -d -m 0755 /opt/santralio "$APP"
cp -r "$REPO/control/src" "$REPO/control/migrations" "$REPO/control/package.json" "$REPO/control/package-lock.json" "$APP/"
(cd "$APP" && npm ci --omit=dev --no-fund --no-audit --silent)
chown -R root:root "$APP"
chmod -R go-w "$APP"
install -m 0755 "$REPO/control/santralio" /usr/local/bin/santralio

# 6. Asterisk: tenants/ dizinini santralio-ctl'e verir, AMI kullanıcısını yükler.
"$REPO/infra/asterisk/deploy.sh"
# Kiracı anonsları: kontrol servisi yazar, Asterisk okur.
install -d -m 2750 -o "$USER_NAME" -g asterisk /var/lib/asterisk/sounds/santralio
asterisk -rx 'module reload manager' >/dev/null

# 7. Şema
/usr/local/bin/santralio migrate

# 8. Yönetim API'si (yalnızca 127.0.0.1:8090)
install -m 0644 "$REPO/control/santralio-api.service" /etc/systemd/system/santralio-api.service
systemctl daemon-reload
systemctl enable --quiet santralio-api
systemctl restart santralio-api
echo "Kontrol servisi kuruldu."
