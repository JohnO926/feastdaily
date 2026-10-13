#!/usr/bin/env bash
# CI guard: the secret alarm instant (daily_alarms.fire_at) may only be read in the alarm
# workflow (src/workflows/alarm*.ts), src/lib/alarm.ts, the dev-reveal route and the admin alarm helpers. Any other
# mention of fire_at / fireAt under src/ fails the build.
set -euo pipefail
cd "$(dirname "$0")/.."

allowed='^src/(workflows/alarm(-steps|-core)?\.ts|lib/alarm\.ts|app/api/v1/dev/|app/api/admin/alarm/|db/schema\.ts|db/migrations/)'

hits=$(grep -rnE 'fire_at|fireAt' src --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.json' \
  | grep -vE "$allowed" || true)

if [[ -n "$hits" ]]; then
  echo "fire_at guard: the secret alarm instant is referenced outside the allowed files:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "fire_at guard: ok"
