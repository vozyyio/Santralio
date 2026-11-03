#!/usr/bin/env bash
# Santralio: dış servis anahtarını sunucuda gizli girişle alır ve systemd-creds ile şifreleyip kaydeder.
# Anahtar ekrana yazılmaz, düz metin olarak diske yazılmaz. Kullanım:
#   sudo infra/set-secret.sh anthropic     # Anthropic API anahtarı (Claude)
#   sudo infra/set-secret.sh azure-speech  # Azure Speech anahtarı (bölge: /etc/santralio/site.env SANTRALIO_AZURE_SPEECH_REGION)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
case "${1:-}" in
  anthropic) NAME=santralio-anthropic-api-key ;;
  azure-speech) NAME=santralio-azure-speech-key ;;
  *) echo "kullanım: $0 anthropic | azure-speech" >&2; exit 1 ;;
esac
read -r -s -p "$1 anahtarı: " KEY </dev/tty
echo
[ -n "$KEY" ] || { echo "boş anahtar" >&2; exit 1; }
install -d -m 0700 /etc/credstore.encrypted
printf '%s' "$KEY" | systemd-creds encrypt --name="$NAME" - "/etc/credstore.encrypted/$NAME"
chmod 0600 "/etc/credstore.encrypted/$NAME"
unset KEY
systemctl restart santralio-ai 2>/dev/null || true
echo "kaydedildi: $NAME (santralio-ai yeniden başlatıldı)"
