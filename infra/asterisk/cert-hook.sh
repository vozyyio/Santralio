#!/usr/bin/env bash
# Santralio: Let's Encrypt sertifikasını Asterisk'e verir.
# certbot deploy hook olarak da çalışır (/etc/letsencrypt/renewal-hooks/deploy/).
# TLS transport'u sertifikayı yalnızca açılışta okur. Yenilemede Asterisk,
# süren çağrılar bitince yeniden başlatılır ("core restart when convenient").
set -euo pipefail

DOMAIN=sip.santralio.site
LIVE=/etc/letsencrypt/live/$DOMAIN
KEYS=/etc/asterisk/keys

install -d -m 0750 -o root -g asterisk "$KEYS"
install -m 0640 -o root -g asterisk "$LIVE/fullchain.pem" "$KEYS/$DOMAIN.crt"
install -m 0640 -o root -g asterisk "$LIVE/privkey.pem" "$KEYS/$DOMAIN.key"

if [ "${1:-}" != "--no-restart" ] && systemctl is-active --quiet asterisk; then
  asterisk -rx 'core restart when convenient' >/dev/null
fi
