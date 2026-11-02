#!/usr/bin/env bash
# Santralio: iki kiracı arasındaki izolasyonu canlı Asterisk üzerinde sınar.
# Kullanım: sudo infra/asterisk/tests/check_isolation.sh <kiracı_a> <kiracı_b>   (ör. t1 t2)
# A'nın trunk'ı olmalı. Hiçbir kaydı değiştirmez; yalnızca okur ve SIP isteği gönderir.
set -uo pipefail
A=$1 B=$2
DIR="$(cd "$(dirname "$0")" && pwd)"
S=/usr/local/bin/santralio
fails=0
check() { if "$@" >/dev/null 2>&1; then echo "  geçti : $DESC"; else echo "  KALDI : $DESC"; fails=$((fails + 1)); fi; }
not() { ! "$@"; }
ast() { asterisk -rx "$1"; }
secret() { $S ext secret "$1" "$2" | awk '/^ *şifre / {print $3}'; }
q() { sudo -u postgres psql -d santralio -tAc "$1"; }

echo "Dialplan: $A dahilileri $B'ye ulaşamaz"
for ctx in "$A-internal" "$A-inbound" "$A-did"; do
  DESC="$ctx içinde $B nesnesi yok"; check not grep -q "$B[_-]" <(ast "dialplan show $ctx")
done
for n in 1001 8001; do
  DESC="$n@$A-internal yalnızca $A'ya gider"
  check grep -qE "PJSIP/${A}_$n|$A-queue-" <(ast "dialplan show $n@$A-internal")
done
DESC="$A-internal'dan ${B}_1001 aranamaz (reject'e düşer)"
check grep -q "reject" <(ast "dialplan show ${B}_1001@$A-internal")

echo "Kuyruk: üyeler yalnızca kendi kiracısından"
DESC="${A}_destek üyelerinin hepsi PJSIP/${A}_"
check not grep -E "PJSIP/" <(ast "queue show ${A}_destek" | grep -E 'PJSIP/' | grep -v "PJSIP/${A}_")

echo "Kayıt: bir kiracının şifresi diğerinde geçmez"
DESC="${B}_1001, ${A}_1001'in şifresiyle kayıt olamaz"
check bash -c "secret() { $S ext secret \$1 \$2 | awk '/^ *şifre / {print \$3}'; }; secret $A 1001 | python3 -I $DIR/check_register.py ${B}_1001 --expect-fail"
DESC="${B}_1001 kendi şifresiyle kayıt olur"
check bash -c "$S ext secret $B 1001 | awk '/^ *şifre / {print \$3}' | python3 -I $DIR/check_register.py ${B}_1001"

echo "Gelen arama: $A'nın trunk'ından $B'nin DID'i reddedilir"
TOK=$(q "SELECT contact_token FROM trunks t JOIN tenants n ON n.id = t.tenant_id WHERE n.prefix = '$A'")
B_DID=$(q "SELECT address FROM entry_points e JOIN tenants n ON n.id = e.tenant_id WHERE n.prefix = '$B' AND channel = 'voice' LIMIT 1")
A_DID=$(q "SELECT address FROM entry_points e JOIN tenants n ON n.id = e.tenant_id WHERE n.prefix = '$A' AND channel = 'voice' LIMIT 1")
DESC="$A trunk'ı + $B DID'i ($B_DID) -> red"; check python3 -I "$DIR/check_inbound.py" "$TOK" "$B_DID" reject
DESC="$A trunk'ı + $A DID'i -> kabul";        check python3 -I "$DIR/check_inbound.py" "$TOK" "$A_DID" accept

echo
[ $fails -eq 0 ] && echo "İzolasyon testi geçti." || echo "İzolasyon testi: $fails kontrol kaldı."
exit $fails
