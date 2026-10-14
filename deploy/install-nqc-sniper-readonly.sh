#!/usr/bin/env bash
# Install only on the user's EXISTING authorized Ubuntu/systemd host.
# No provisioning, credentials, wallet, trades or recurring cloud purchases.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Usage: bash deploy/install-nqc-sniper-readonly.sh ABS_CHECKOUT EXACT_COMMIT' >&2
  exit 2
fi
checkout=$1
expected=$2
[[ "$checkout" = /* && "$expected" =~ ^[0-9a-f]{40}$ ]]
[ "$(id -u)" -eq 0 ]
[ "$(git -C "$checkout" rev-parse HEAD)" = "$expected" ]
command -v python3 >/dev/null
command -v systemctl >/dev/null
[ -d /run/systemd/system ]
unit=/etc/systemd/system/nqc-v2-sniper-readonly.service
base=/opt/nqc/sniper-readonly
# Never replace an unknown existing install or overwrite its evidence.
[ ! -e "$unit" ] && [ ! -L "$unit" ]
[ ! -e "$base/current" ] && [ ! -L "$base/current" ]
systemctl is-active --quiet nqc-v2-sniper-readonly.service && exit 2
source_dir=ci/nqc-census/rmc-v2-shadow
files=(
  "$source_dir/sniper_readonly_observer.py"
  "$source_dir/sniper_readonly_journal.py"
  "$source_dir/sniper_continuous_service.py"
  "$source_dir/test_sniper_readonly_observer.py"
  "$source_dir/test_sniper_readonly_journal.py"
  "$source_dir/test_sniper_continuous_service.py"
  deploy/systemd/nqc-v2-sniper-readonly.service
  deploy/install-nqc-sniper-readonly.sh
)
for file in "${files[@]}"; do
  [ -f "$checkout/$file" ] && [ ! -L "$checkout/$file" ]
  [ "$(git -C "$checkout" hash-object -- "$file")" = "$(git -C "$checkout" rev-parse "$expected:$file")" ]
done
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$checkout/$source_dir" -p test_sniper_readonly_observer.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$checkout/$source_dir" -p test_sniper_readonly_journal.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$checkout/$source_dir" -p test_sniper_continuous_service.py
if id nqc-sniper >/dev/null 2>&1; then
  echo 'Existing nqc-sniper identity: inspect before installation.' >&2
  exit 2
fi
release="$base/releases/$expected"
[ ! -e "$release" ]
useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin nqc-sniper
install -d -m 0755 -o root -g root "$release"
for name in sniper_readonly_observer.py sniper_readonly_journal.py sniper_continuous_service.py; do
  install -m 0444 -o root -g root "$checkout/$source_dir/$name" "$release/$name"
done
printf 'NQC_SOURCE_COMMIT=%s\n' "$expected" > "$release/source.env"
chmod 0444 "$release/source.env"
ln -s "$release" "$base/current"
install -m 0644 -o root -g root "$checkout/deploy/systemd/nqc-v2-sniper-readonly.service" "$unit"
systemd-analyze verify "$unit"
systemctl daemon-reload
systemctl enable --now nqc-v2-sniper-readonly.service
systemctl show nqc-v2-sniper-readonly.service -p ActiveState -p SubState -p MainPID -p NRestarts
echo 'Service start requested. Verify fresh journal, health, process restart and host reboot before claiming continuous operation.'
