#!/usr/bin/env python3
"""Pick a time zone and rollover hour (0-9) whose next rollover is a few minutes away, for the live E2E test.

Prints: TZ ROLLOVER SECONDS_UNTIL
"""
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, available_timezones

lo = int(sys.argv[1]) if len(sys.argv) > 1 else 150
hi = int(sys.argv[2]) if len(sys.argv) > 2 else 900
now = datetime.now(timezone.utc)
best = None
for name in sorted(available_timezones()):
    if "/" not in name or name.startswith(("Etc/", "SystemV/", "posix/", "right/")):
        continue
    local = now.astimezone(ZoneInfo(name))
    for hour in range(10):
        cand = local.replace(hour=hour, minute=0, second=0, microsecond=0)
        if cand <= local:
            cand += timedelta(days=1)
        secs = (cand - local).total_seconds()
        if lo <= secs <= hi and (best is None or secs < best[2]):
            best = (name, hour, int(secs))
if not best:
    sys.exit("no zone found in range")
print(*best)
