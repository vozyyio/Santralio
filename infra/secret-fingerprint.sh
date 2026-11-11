#!/usr/bin/env bash
# Santralio: bir systemd credential'ının SHA-256 parmak izinin ilk 12 onaltılık
# karakterini yazar. Credential değerini, tam özeti ve başka bir gizli bilgiyi
# yazmaz. Ağ kullanmaz.
#
# Çözüm, depodaki diğer betiklerle aynıdır:
#   1. $CREDENTIALS_DIRECTORY/<ad>     (control/src/config.ts)
#   2. /etc/credstore.encrypted/<ad>   (systemd-creds decrypt; control/install.sh, infra/set-secret.sh)
#
# Kullanım: infra/secret-fingerprint.sh <ad>
# Örnek:    sudo infra/secret-fingerprint.sh santralio-vozyy-inbound-key
set +x
set -euo pipefail
umask 077

usage() { echo "kullanım: $0 <ad>" >&2; exit 1; }

name="${1:-}"
[ "$#" -eq 1 ] || usage
# systemd credential dosya adı. Yol, boşluk veya seçenek kabul edilmez.
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || usage

tmp=""
cleanup() {
  if [ -n "${tmp}" ] && [ -e "${tmp}" ]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u -n 1 -- "${tmp}" 2>/dev/null || rm -f -- "${tmp}"
    else
      rm -f -- "${tmp}"
    fi
  fi
}
trap cleanup EXIT

tmp="$(mktemp)"

# Dosya, verilen dizinin içinde düz bir dosya mı (sembolik bağ değil)?
inside_file() {
  local dir="$1" file="$2" realdir real
  [ -n "$dir" ] && [ -f "$file" ] && [ ! -L "$file" ] || return 1
  realdir="$(cd -- "$dir" && pwd -P)"
  real="$(cd -- "$(dirname -- "$file")" && pwd -P)/$(basename -- "$file")"
  case "$real" in
    "$realdir"/*) return 0 ;;
    *) return 1 ;;
  esac
}

found=0
if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && inside_file "$CREDENTIALS_DIRECTORY" "$CREDENTIALS_DIRECTORY/$name"; then
  cat -- "$CREDENTIALS_DIRECTORY/$name" >"$tmp"
  found=1
fi

if [ "$found" -eq 0 ]; then
  # control/install.sh ile aynı depo. SANTRALIO_CREDSTORE yalnızca bir test düzeneği içindir.
  store="${SANTRALIO_CREDSTORE:-/etc/credstore.encrypted}"
  enc="$store/$name"
  if inside_file "$store" "$enc"; then
    if ! systemd-creds decrypt --name="$name" -- "$enc" "$tmp" 2>/dev/null; then
      echo "credential okunamadı: $name" >&2
      exit 1
    fi
    found=1
  fi
fi

if [ "$found" -eq 0 ] || [ ! -s "$tmp" ]; then
  echo "credential yok: $name" >&2
  exit 1
fi

# sha256sum: "<64 hex>  <dosya>". Tam özet yazılmaz.
line="$(sha256sum -- "$tmp")" || { echo "parmak izi hesaplanamadı" >&2; exit 1; }
hex="${line%% *}"
[[ "$hex" =~ ^[0-9a-f]{64}$ ]] || { echo "parmak izi hesaplanamadı" >&2; exit 1; }
printf '%s\n' "${hex:0:12}"
