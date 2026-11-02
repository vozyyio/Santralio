#!/usr/bin/env bash
# Santralio: operatör IP aralıklarını (operator_ip_ranges) 5060 için ufw izni olarak ekler.
# Yalnızca izin ekler; hiçbir kuralı silmez ve 22 portuna dokunmaz.
# Bir aralık kaldırılırsa ufw kuralı elle silinmelidir: sudo ufw status numbered
# Kullanım: sudo infra/firewall-sync.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırın" >&2; exit 1; }
cd /
sudo -u postgres psql -d santralio -tA -F' ' -c "SELECT operator, cidr FROM operator_ip_ranges ORDER BY operator, cidr" |
while read -r operator cidr; do
  [ -n "$cidr" ] || continue
  for proto in udp tcp; do
    ufw allow proto "$proto" from "$cidr" to any port 5060 comment "Santralio operatör: $operator" >/dev/null
  done
  echo "izinli: $operator $cidr -> 5060/udp,tcp"
done
