# Feast Daily API (v1)

The server is the only source of truth for scoring. The iOS client records reading sessions,
uploads them, and renders what these endpoints return. Every endpoint below is implemented in
`server/src/app/api/**/route.ts`; the request bodies are validated with the zod schemas in
`server/src/lib/validation.ts`.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | `http://localhost:3000` (simulator, `npm run dev`), the Mac's LAN address or a Vercel preview URL for a device. All paths below are relative to it. |
| Format | JSON request and response bodies (`content-type: application/json`). Keys are `snake_case`. Responses carry `cache-control: no-store`. |
| Timestamps | Responses: ISO 8601 UTC with milliseconds, always `YYYY-MM-DDTHH:MM:SS.sssZ` (e.g. `2026-10-13T04:30:00.000Z`). Requests: any ISO 8601 date-time **with** an offset or `Z` (`2026-10-13T04:31:00Z`, `2026-10-12T22:31:00-06:00`); send UTC with milliseconds to match. |
| Day keys | `YYYY-MM-DD` (`2026-10-13`): the user's local date of the day window (a day runs from one local rollover to the next). |
| Alarm dates | `YYYY-MM-DD` calendar date in America/Denver (the shared alarm zone). |
| Durations | Integer seconds (`goal_seconds`, `active_seconds`, `verified_seconds`), unless the field name ends in `_ms` (integer milliseconds, e.g. `mono_start_ms`). |
| Local times | `HH:MM`, 24 h (`reminder_local_time: "07:30"`). |
| Nullability | Every key listed for a response is always present. Fields marked *nullable* hold `null` when not applicable; they are never omitted. |
| Auth | `Authorization: Bearer <token>` from `POST /api/v1/auth/register` on every endpoint except register. Tokens are HS256 JWTs valid for 1 year. On `401` the client re-registers with its stored device key (same key, same user) and retries once. |

### Optional request headers (any authenticated endpoint)

| Header | Value | Effect |
|---|---|---|
| `X-Feast-Boot-Id` | the current `kern.bootsessionuuid` | Records **boot contact** for this boot (see the no-backdating rule below), unless the request is passive. With `X-Feast-Mono-Ms` it also refines the boot's monotonic anchor (`anchor_offset_ms = min(received_at - mono)`). Send it on every app request. |
| `X-Feast-Mono-Ms` | integer, `mach_continuous_time` in ms (same clock as `mono_*_ms`) | See above. |
| `X-Feast-Passive` | `1` | Marks a background fetch (the widget timeline provider). It counts as neither device contact nor boot contact and does not refresh `last_seen_at`. The widget must send it. |

### No-backdating rule and request ordering

The server records two kinds of "last contact", both only from non-passive requests:

- **Boot contact**: the last request carrying a given boot id, either the `POST /sessions`
  envelope's `boot_id` or the `X-Feast-Boot-Id` header.
- **Device contact**: the last request with this device credential, whatever boot sent it (a
  second iPhone sharing the credential through iCloud Keychain counts too). Requests without a
  boot id count only here.

A session is checked against one reference, chosen by its own `boot_id`:

- **Known boot** (the server has seen this boot id for this device, and that boot has made at
  least one non-passive request): the session must end no earlier than 60 s before **that
  boot's** last contact. Requests from other boots or other iPhones never affect it, so phone A
  reading offline still scores while phone B (same device id, different boot) is online.
- **Unknown boot** (never seen before, or only seen through an uploaded session): the session
  must end no earlier than 60 s before the **device's** last contact. A made-up boot id
  therefore cannot get past the rule. The boot is recorded after this check.

A session that fails the check is kept for history only (`reason: "backdated"`,
`scored: false`). For the app this means:

1. Send `X-Feast-Boot-Id` (and `X-Feast-Mono-Ms`) on every request, so this boot's contact is
   tracked separately from the other devices that share the credential.
2. When unsynced sessions exist, **make `POST /api/v1/sessions` the first request after
   regaining connectivity**, before `GET /home` and friends. Any earlier request from the same
   boot moves that boot's contact past the offline reading.
3. Sessions recorded before a reboot are judged by the old boot's contact if that boot ever made
   a request, so requests after the reboot don't hurt them. If the old boot never made a
   request, they are judged by device contact, so upload them in the first request after the
   reboot.
4. The widget must send `X-Feast-Passive: 1`.

### Errors

Every error uses the same envelope and an HTTP status:

```json
{ "error": { "code": "invalid_request", "message": "Request validation failed", "details": { "errors": [], "properties": { "goal_seconds": { "errors": ["goal_seconds must be 45..300 in 15 s steps or 300..2700 in 60 s steps"] } } } } }
```

`details` is present only for `invalid_request` (zod `treeifyError` output: `errors` at each
level, `properties` for object keys, `items` for array indexes).

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_json` | Body is not JSON. |
| 400 | `invalid_request` | Body/query failed validation (see `details`). |
| 400 | `invalid_reminder_time` | `reminder_local_time` earlier than `rollover_hour:00`. |
| 400 | `invalid_range`, `range_too_large` | `GET /history` with `from > to` or more than 93 days. |
| 401 | `invalid_token` | Missing/invalid/expired bearer token, user deleted, or device credential revoked. Re-register. |
| 401 | `invalid_credentials` | `POST /auth/register` with a known `device_id` but a different secret. |
| 403 | `device_mismatch` | `POST /sessions` envelope `device_id` differs from the token's device. |
| 404 | `not_found` | `GET /dev/today-alarm` when `DEV_REVEAL_ALARM` is not `true`. |
| 409 | `not_onboarded` | `PATCH /settings` before `POST /onboarding`. |
| 429 | `rate_limited` | Too many registrations from one IP in an hour. |
| 500 | `internal` | Anything else (never echoes rows). |

### Enumerations

| Name | Values |
|---|---|
| `today.status` | `not_started` (the day window has not begun, e.g. day 0 before `first_day_starts_at`), `racing` (alarm not fired yet, goal not met), `safe` (goal met before the alarm or self-reported before it), `missed` (alarm fired, not safe). |
| day `result` | `pending` (open day), `feast`, `missed`. In `/history`, `null` for a day that has history-only reading but no scored window (e.g. before the first day). |
| session `source` | `reader`, `self_report`, `audio` (phase 3). |
| per-session `status` | `accepted`, `duplicate`, `rejected`. |
| alarm push `kind` | `alarm`, `safe`, `moment`. |

---

## POST /api/v1/auth/register

Exchanges the device key for a bearer token. The same `device_id` + `device_secret` always
returns the same user (reinstall-safe when the key lives in the synchronizable Keychain). An
unknown `device_id` creates a new anonymous user. Rate-limited per client IP (default 30/hour).

Request:

```json
{
  "device_id": "1e52007a-98a2-42c9-ba94-87efaf2f2dc3",
  "device_secret": "9f1c2b7e5a0d4c3b8e6f1a2d3c4b5a69788f6e5d4c3b2a1908f7e6d5c4b3a291"
}
```

| Field | Type | Rules |
|---|---|---|
| `device_id` | string | UUID, generated once per install identity. |
| `device_secret` | string | 32 to 256 chars (32 random bytes, hex = 64 chars). Stored server-side only as a SHA-256 hash. |

Response `201` (new user) or `200` (existing):

```json
{
  "user_id": "37931f9e-bde7-4789-b4d0-34c2ed12364f",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkaWQiOiIxZTUyMDA3YS05OGEyLTQyYzktYmE5NC04N2VmYWYyZjJkYzMiLCJzdWIiOiIzNzkzMWY5ZS1iZGU3LTQ3ODktYjRkMC0zNGMyZWQxMjM2NGYiLCJpYXQiOjE3OTE4NjUwNzcsImV4cCI6MTgyMzQwMTA3N30.B6ug1EX8JnRUBciL0_-aYUjgPa8RgqJJCHU3Q1cpovI",
  "token_expires_at": "2027-10-13T04:17:57.000Z",
  "created": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `user_id` | string (UUID) | Opaque user id. |
| `token` | string | Bearer JWT (`sub` = user id, `did` = device id). |
| `token_expires_at` | timestamp | One year after issue. |
| `created` | boolean | `true` when this call created the user. |

Errors: `400 invalid_request`, `401 invalid_credentials`, `429 rate_limited`.

---

## GET /api/v1/home

The client read model. Every call first closes any due day and opens the next one (lazy
rollover), so the response is always current. Mutating endpoints (`/onboarding`, `/settings`,
`/sessions`, `/devices`) return the same object under `home`, so the widget cache refreshes in
one round trip.

Request: no body. Example response (onboarded user, day in progress, goal met):

```json
{
  "server_now": "2026-10-13T04:40:12.345Z",
  "onboarded": true,
  "settings": {
    "tz": "Asia/Tehran",
    "rollover_hour": 8,
    "goal_seconds": 120,
    "pending_goal_seconds": null,
    "reminder_enabled": true,
    "reminder_local_time": "08:30"
  },
  "today": {
    "day_key": "2026-10-13",
    "window_start": "2026-10-13T04:30:00.000Z",
    "window_end": "2026-10-14T04:30:00.000Z",
    "goal_seconds": 120,
    "verified_seconds": 140,
    "verified_before_alarm_seconds": 140,
    "goal_reached_at": "2026-10-13T04:33:50.000Z",
    "self_reported_at": null,
    "alarm_at": null,
    "status": "safe"
  },
  "first_day_starts_at": "2026-10-13T04:30:00.000Z",
  "alarm": {
    "alarm_date": "2026-10-12",
    "fired": false,
    "fired_at": null,
    "beat_count": null,
    "reader_count": null,
    "beat_pct": null
  },
  "stats": {
    "current_streak": 0,
    "longest_streak": 0,
    "total_feasts": 0,
    "active_missed_meals": 0,
    "famine": false,
    "restore_progress": 0
  },
  "missed_meals": [],
  "last_closed": null,
  "config": {
    "famine_threshold": 3,
    "missed_meal_expiry_days": 30,
    "feasts_to_restore": 4,
    "alarm_window": { "tz": "America/Denver", "start": "10:00", "end": "20:30" }
  }
}
```

A user with history looks like this in the parts that differ:

```json
{
  "stats": { "current_streak": 0, "longest_streak": 6, "total_feasts": 11, "active_missed_meals": 2, "famine": false, "restore_progress": 1 },
  "missed_meals": [
    { "occurred_at": "2026-10-03T21:12:40.000Z", "expires_at": "2026-11-02T21:12:40.000Z" },
    { "occurred_at": "2026-10-11T18:05:02.000Z", "expires_at": "2026-11-10T18:05:02.000Z" }
  ],
  "last_closed": { "day_key": "2026-10-12", "result": "missed" }
}
```

Before onboarding: `onboarded: false`, `settings: null`, `today: null`, `first_day_starts_at: null`,
zeroed `stats`, `missed_meals: []`, `last_closed: null` (`alarm` and `config` are always filled).

| Field | Type | Meaning |
|---|---|---|
| `server_now` | timestamp | Server clock at response time. The client derives its "now" for day logic from this plus elapsed monotonic time. |
| `onboarded` | boolean | `POST /onboarding` has completed. When `false`, show onboarding. |
| `settings` | object, *nullable* | `null` before onboarding. |
| `settings.tz` | string | IANA time zone the server uses for day windows. |
| `settings.rollover_hour` | integer 0..9 | Local hour at which a day ends and the next begins. |
| `settings.goal_seconds` | integer | Goal of the current day (and future days unless `pending_goal_seconds` is set). |
| `settings.pending_goal_seconds` | integer, *nullable* | A goal change that takes effect at the next rollover ("Goal becomes 10 min tomorrow"). |
| `settings.reminder_enabled` | boolean | Morning reminder on/off (the reminder is a local notification). |
| `settings.reminder_local_time` | `HH:MM`, *nullable* | Reminder time in `settings.tz`. |
| `today` | object, *nullable* | The open (pending) day. `null` only before onboarding. |
| `today.day_key` | day key | Local date of the day. Group local unsynced sessions by this. |
| `today.window_start` / `today.window_end` | timestamp | The day window `[start, end)`. Usually 24 h; 23/25 h across DST; 12 h to 36 h after a time zone change. The client splits a running session at `window_end`. |
| `today.goal_seconds` | integer | Goal for this day (fixed once the day starts). |
| `today.verified_seconds` | integer | Verified reading credited to this day (all scorable reader/audio time, before and after the alarm). Drives the progress ring. |
| `today.verified_before_alarm_seconds` | integer | The part of `verified_seconds` anchored at or before `alarm_at` (a session straddling the alarm counts only its earlier part). Equals `verified_seconds` while `alarm_at` is `null`. After the alarm this, not `verified_seconds`, decides the day: `safe` iff it is `>= goal_seconds` or the self-report is at or before `alarm_at`. The client adds unsynced local reading that ended at or before `alarm_at` to it to predict whether pending uploads will make a missed day safe. |
| `today.goal_reached_at` | timestamp, *nullable* | Instant cumulative verified time crossed the goal (interpolated inside the session that crossed it). |
| `today.self_reported_at` | timestamp, *nullable* | Anchored tap instant of today's "I read somewhere else" self-report. |
| `today.alarm_at` | timestamp, *nullable* | The alarm instant that decides this day, set only after the shared alarm has fired. `null` while racing. |
| `today.status` | enum | `not_started` / `racing` / `safe` / `missed` (see Enumerations). Show the self-report button only while `racing`. |
| `first_day_starts_at` | timestamp, *nullable* | Start of the first scored day (the first rollover after onboarding). No alarm notifications before it. |
| `alarm` | object | Today's shared alarm (America/Denver date). Same shape as `GET /alarm/today`. |
| `alarm.alarm_date` | alarm date | Denver calendar date. |
| `alarm.fired` | boolean | The alarm has gone off. |
| `alarm.fired_at` | timestamp, *nullable* | When it went off ("went off at 2:47 PM"). `null` until fired. |
| `alarm.beat_count` | integer, *nullable* | Readers who were safe at fire time. `null` until fired. |
| `alarm.reader_count` | integer, *nullable* | Readers (seen within 7 days) whose day contained the alarm. `null` until fired. |
| `alarm.beat_pct` | integer 0..100, *nullable* | `round(100 * beat_count / reader_count)`; `null` until fired or when `reader_count` is 0. |
| `stats.current_streak` | integer | Consecutive feasts up to the last closed day. |
| `stats.longest_streak` | integer | Best streak ever. |
| `stats.total_feasts` | integer | All-time feasts. |
| `stats.active_missed_meals` | integer | Missed meals not yet expired or restored, computed at `server_now`. |
| `stats.famine` | boolean | `active_missed_meals >= config.famine_threshold`, computed at `server_now`. |
| `stats.restore_progress` | integer | Consecutive feasts counted toward restoring the oldest missed meal (resets on a miss or a restore; restoring happens at `config.feasts_to_restore`). |
| `missed_meals` | array | Active missed meals, oldest first. Render as marks. |
| `missed_meals[].occurred_at` | timestamp | The deciding instant of the missed day (its alarm, or its window end when no alarm landed in it). |
| `missed_meals[].expires_at` | timestamp | `occurred_at + missed_meal_expiry_days`; the mark disappears at this instant. |
| `last_closed` | object, *nullable* | Most recently closed day. `null` if none. |
| `last_closed.day_key` | day key | |
| `last_closed.result` | `feast` \| `missed` | Provisional: a late offline session synced within 48 h can still flip a `missed` day to `feast`. |
| `config.famine_threshold` | integer | Server-tunable. |
| `config.missed_meal_expiry_days` | integer | Server-tunable. |
| `config.feasts_to_restore` | integer | Server-tunable. |
| `config.alarm_window` | object | `{tz, start, end}`: the alarm can fire any time in `[start, end)` local to `tz` (`"America/Denver"`, `"10:00"`, `"20:30"`). |

The response never contains the secret alarm instant before it fires.

---

## POST /api/v1/onboarding

Saves the settings, sets `first_day_starts_at` to the next rollover in the chosen zone, and opens
day 0 in one transaction. Idempotent: calling it again on an onboarded user only applies the
settings (same rules as `PATCH /settings`).

Request:

```json
{
  "tz": "America/Denver",
  "rollover_hour": 3,
  "goal_seconds": 600,
  "reminder_enabled": true,
  "reminder_local_time": "07:30"
}
```

| Field | Type | Rules |
|---|---|---|
| `tz` | string | Required. Valid IANA zone (`TimeZone.current.identifier`). |
| `rollover_hour` | integer | Optional, default `3`. 0..9. |
| `goal_seconds` | integer | Required. 45..300 in steps of 15, or 300..2700 in steps of 60. |
| `reminder_enabled` | boolean | Optional, default `false`. |
| `reminder_local_time` | `HH:MM`, nullable | Optional, default `null`. Must be at or after `rollover_hour:00` (`400 invalid_reminder_time`). The app also keeps it before the alarm window opens in the user's zone. |

Response `200`:

```json
{
  "settings": {
    "tz": "America/Denver",
    "rollover_hour": 3,
    "goal_seconds": 600,
    "pending_goal_seconds": null,
    "reminder_enabled": true,
    "reminder_local_time": "07:30"
  },
  "first_day_starts_at": "2026-10-13T09:00:00.000Z",
  "home": { "server_now": "2026-10-12T16:00:00.000Z", "onboarded": true, "settings": { "tz": "America/Denver", "rollover_hour": 3, "goal_seconds": 600, "pending_goal_seconds": null, "reminder_enabled": true, "reminder_local_time": "07:30" }, "today": { "day_key": "2026-10-13", "window_start": "2026-10-13T09:00:00.000Z", "window_end": "2026-10-14T09:00:00.000Z", "goal_seconds": 600, "verified_seconds": 0, "verified_before_alarm_seconds": 0, "goal_reached_at": null, "self_reported_at": null, "alarm_at": null, "status": "not_started" }, "first_day_starts_at": "2026-10-13T09:00:00.000Z", "alarm": { "alarm_date": "2026-10-12", "fired": false, "fired_at": null, "beat_count": null, "reader_count": null, "beat_pct": null }, "stats": { "current_streak": 0, "longest_streak": 0, "total_feasts": 0, "active_missed_meals": 0, "famine": false, "restore_progress": 0 }, "missed_meals": [], "last_closed": null, "config": { "famine_threshold": 3, "missed_meal_expiry_days": 30, "feasts_to_restore": 4, "alarm_window": { "tz": "America/Denver", "start": "10:00", "end": "20:30" } } }
}
```

| Field | Type | Meaning |
|---|---|---|
| `settings` | object | Same shape as `home.settings`. |
| `first_day_starts_at` | timestamp | First scored day starts here. |
| `home` | object | Full `GET /home` payload. |

Errors: `400 invalid_request`, `400 invalid_reminder_time`.

---

## GET /api/v1/settings

Response `200`: `{ "settings": <home.settings object or null> }`.

```json
{ "settings": { "tz": "America/Denver", "rollover_hour": 3, "goal_seconds": 600, "pending_goal_seconds": 900, "reminder_enabled": true, "reminder_local_time": "07:30" } }
```

## PATCH /api/v1/settings

Partial update; send only the keys that change. Unknown keys are rejected.

Rules:

- `goal_seconds`: applies at the next rollover (stored as `pending_goal_seconds`), except on
  day 0 before the first day starts, where it applies directly. Setting it back to the current
  goal clears the pending change.
- `tz` / `rollover_hour`: apply to the open day immediately. Its `window_end` moves to the next
  rollover in the new settings (never earlier than now or a fired alarm; the day stays between
  12 and 36 h). Send `tz` whenever `TimeZone.current.identifier` changes.
- `reminder_*`: stored for the client; the reminder is a local notification.

Request:

```json
{ "goal_seconds": 900 }
```

| Field | Type | Rules |
|---|---|---|
| `tz` | string | Optional. Valid IANA zone. |
| `rollover_hour` | integer | Optional. 0..9. |
| `goal_seconds` | integer | Optional. Same rule as onboarding. |
| `reminder_enabled` | boolean | Optional. |
| `reminder_local_time` | `HH:MM` or `null` | Optional. At or after the (resulting) `rollover_hour:00`. |

Response `200`:

```json
{
  "settings": {
    "tz": "America/Denver",
    "rollover_hour": 3,
    "goal_seconds": 600,
    "pending_goal_seconds": 900,
    "reminder_enabled": true,
    "reminder_local_time": "07:30"
  },
  "home": { "...": "full GET /home payload; today.goal_seconds stays 600" }
}
```

Errors: `400 invalid_request`, `400 invalid_reminder_time`, `409 not_onboarded`.

---

## POST /api/v1/sessions

Uploads reading sessions (and self-reports). Idempotent by session `id`: re-uploading returns
the stored outcome as `duplicate`. Upload on session end, every 60 s while reading (checkpoint
splits), the moment local verified time crosses the goal, on foreground, and after onboarding.

The server anchors every session to server time using the device's monotonic clock; the device
wall clock is never trusted for the current boot.

Request (envelope, at most 200 sessions):

```json
{
  "device_id": "1e52007a-98a2-42c9-ba94-87efaf2f2dc3",
  "boot_id": "C6B5A1E2-3F4D-4E5F-8A9B-0C1D2E3F4A5B",
  "client_now_wall": "2026-10-13T04:35:00.000Z",
  "client_now_mono_ms": 3600000,
  "sessions": [
    {
      "id": "6f1d3c2b-8a7e-4b5c-9d0e-1f2a3b4c5d6e",
      "source": "reader",
      "boot_id": "C6B5A1E2-3F4D-4E5F-8A9B-0C1D2E3F4A5B",
      "started_at_wall": "2026-10-13T04:31:00.000Z",
      "ended_at_wall": "2026-10-13T04:32:10.000Z",
      "mono_start_ms": 3360000,
      "mono_end_ms": 3430000,
      "active_seconds": 70,
      "content_ref": "bom/2-ne/32"
    },
    {
      "id": "0a9b8c7d-6e5f-4a3b-8c1d-2e3f4a5b6c7d",
      "source": "self_report",
      "boot_id": "C6B5A1E2-3F4D-4E5F-8A9B-0C1D2E3F4A5B",
      "started_at_wall": "2026-10-13T04:34:00.000Z",
      "ended_at_wall": "2026-10-13T04:34:00.000Z",
      "mono_start_ms": 3540000,
      "mono_end_ms": 3540000,
      "active_seconds": 0,
      "content_ref": null
    }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `device_id` | UUID | Must equal the token's device (`403 device_mismatch`). |
| `boot_id` | string 1..128 | Current `kern.bootsessionuuid`. |
| `client_now_wall` | timestamp | Device wall clock at send time (used only to anchor sessions from an unknown earlier boot). |
| `client_now_mono_ms` | integer ≥ 0 | `mach_continuous_time` in ms at send time. |
| `sessions` | array, ≤ 200 | May be empty (still records device contact, boot contact for `boot_id`, and the boot anchor). |
| `sessions[].id` | UUID | Client-generated, stable across retries. |
| `sessions[].source` | enum | `reader`, `self_report`, or `audio`. |
| `sessions[].boot_id` | string 1..128 | Boot during which the session was recorded (may differ from the envelope's after a reboot). |
| `sessions[].started_at_wall`, `ended_at_wall` | timestamp | Device wall clock at start/end. |
| `sessions[].mono_start_ms`, `mono_end_ms` | integer ≥ 0 | Monotonic clock (`mach_continuous_time`, ms) at start/end, same clock as `client_now_mono_ms` when `boot_id` matches. |
| `sessions[].active_seconds` | integer ≥ 0 | Verified reading seconds from the timer machine. `> 0` for `reader`/`audio`; exactly `0` for `self_report`. |
| `sessions[].content_ref` | string ≤ 200, nullable | Optional, e.g. `"bom/2-ne/32"` (history / reading plans only; never sent to analytics). |

A self-report is a zero-length session (`started == ended`, `mono_start_ms == mono_end_ms`,
`active_seconds: 0`) at the tap instant. It counts only if its anchored tap instant is at or
before the alarm; one tapped after the alarm is refused (`self_report_after_alarm`). One per day.

Response `200`:

```json
{
  "results": [
    { "id": "6f1d3c2b-8a7e-4b5c-9d0e-1f2a3b4c5d6e", "status": "accepted", "reason": null, "day_key": "2026-10-13", "scored": true },
    { "id": "0a9b8c7d-6e5f-4a3b-8c1d-2e3f4a5b6c7d", "status": "accepted", "reason": null, "day_key": "2026-10-13", "scored": true }
  ],
  "home": { "...": "full GET /home payload, after ingest and rollover" }
}
```

Per-session result (one per input session, same order):

| Field | Type | Meaning |
|---|---|---|
| `id` | UUID | The input session id. |
| `status` | `accepted` \| `duplicate` \| `rejected` | `accepted`: stored as verified (see `scored`). `duplicate`: this id was uploaded before; the other fields repeat the stored outcome; mark it synced. `rejected`: stored as unverified, never counts; show `reason` (do not silently drop). |
| `reason` | string, *nullable* | `null` for a clean accept. For `accepted`: informational `backdated` or `stale` (history only). For `rejected`: one of the reject reasons below. |
| `day_key` | day key, *nullable* | Day the session (its first piece) was filed under. `null` for rejected sessions. |
| `scored` | boolean | `true` if the session counts toward a scored day. `false` for rejected, history-only (`backdated`, `stale`), and pre-first-day sessions. |

Mark a row `synced` on `accepted` or `duplicate`, `rejected` (with `reason`) on `rejected`.

Reasons:

| `reason` | Status | Meaning |
|---|---|---|
| `malformed` | rejected | Bad shape: `active_seconds` must be > 0 (reader/audio) or 0 (self-report); end must be after start (both clocks). |
| `mono_future` | rejected | A current-boot session ends after `client_now_mono_ms`. |
| `future` | rejected | An earlier-boot session anchors more than 60 s in the future. |
| `span_too_long` | rejected | Anchored span over 6 h (split long sessions; the client splits every 60 min). |
| `active_exceeds_span` | rejected | `active_seconds` exceeds the span + 5 s, or 4 h ("45 minutes in 5 minutes"). |
| `overlap` | rejected | Overlaps an already-scored session by more than 5 s (e.g. a second device reading at the same time). Overlaps up to 5 s are trimmed silently. |
| `daily_cap` | rejected | The day would exceed 16 h of credited reading. |
| `self_report_after_alarm` | rejected | Self-report tapped after the day's alarm. |
| `duplicate_self_report` | rejected | The day already has a self-report. |
| `backdated` | accepted, `scored: false` | Ended more than 60 s before the last contact that applies to it: its own boot's last contact for a known boot, the device's last contact for an unknown boot (see "No-backdating rule"). History only. |
| `stale` | accepted, `scored: false` | Started more than 48 h before upload. History only. |

Server-side behavior the client can rely on:

- Server instants (`server_start_at`, `goal_reached_at`, ...) are `mono + anchor_offset_ms`,
  where the boot's anchor is the minimum `received_at - client_now_mono_ms` ever observed. They
  can sit a few hundred ms later than the device's wall times (one-way network latency); the
  anchor only improves as more requests are seen.
- Sessions are split at day-window boundaries, `first_day_starts_at`, and a fired alarm
  instant, and each piece is filed under the day containing it (so a session across the
  rollover credits both days; `day_key` reports the first piece).
- Time read before the alarm decides the day even if it is synced after the alarm fired. A
  `missed` day flips to `feast` when a verified session read before its alarm arrives within
  48 h of the day's `window_end`; streaks of later days are recomputed.
- Reading after the alarm still counts toward `verified_seconds` and history, never toward the
  result.

Errors: `400 invalid_request` (the whole batch), `403 device_mismatch`.

---

## GET /api/v1/history?from=YYYY-MM-DD&to=YYYY-MM-DD

Calendar data: scored days plus history-only reading, grouped by day key, inclusive range of at
most 93 days. `to` defaults to today's `day_key`, `from` to `to - 29 days`.

Request: `GET /api/v1/history?from=2026-10-12&to=2026-10-15`

Response `200`:

```json
{
  "from": "2026-10-12",
  "to": "2026-10-15",
  "days": [
    {
      "day_key": "2026-10-12",
      "result": null,
      "window_start": null,
      "window_end": null,
      "goal_seconds": null,
      "verified_seconds": 0,
      "verified_before_alarm_seconds": 0,
      "total_seconds": 300,
      "goal_reached_at": null,
      "self_reported_at": null,
      "alarm_at": null,
      "rescored": false,
      "sessions": [
        { "id": "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b", "session_id": "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b", "source": "reader", "server_start_at": "2026-10-12T17:00:00.000Z", "server_end_at": "2026-10-12T17:06:00.000Z", "active_seconds": 300, "scorable": true, "scored": false, "reason": null, "content_ref": "bom/1-ne/1" }
      ]
    },
    {
      "day_key": "2026-10-13",
      "result": "feast",
      "window_start": "2026-10-13T09:00:00.000Z",
      "window_end": "2026-10-14T09:00:00.000Z",
      "goal_seconds": 600,
      "verified_seconds": 660,
      "verified_before_alarm_seconds": 660,
      "total_seconds": 660,
      "goal_reached_at": "2026-10-13T12:54:54.545Z",
      "self_reported_at": null,
      "alarm_at": "2026-10-13T20:47:00.000Z",
      "rescored": false,
      "sessions": [
        { "id": "6f1d3c2b-8a7e-4b5c-9d0e-1f2a3b4c5d6e", "session_id": "6f1d3c2b-8a7e-4b5c-9d0e-1f2a3b4c5d6e", "source": "reader", "server_start_at": "2026-10-13T12:00:00.000Z", "server_end_at": "2026-10-13T12:06:00.000Z", "active_seconds": 330, "scorable": true, "scored": true, "reason": null, "content_ref": "bom/1-ne/1" },
        { "id": "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", "session_id": "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", "source": "reader", "server_start_at": "2026-10-13T12:50:00.000Z", "server_end_at": "2026-10-13T12:56:00.000Z", "active_seconds": 330, "scorable": true, "scored": true, "reason": null, "content_ref": "bom/1-ne/2" }
      ]
    },
    {
      "day_key": "2026-10-14",
      "result": "missed",
      "window_start": "2026-10-14T09:00:00.000Z",
      "window_end": "2026-10-15T09:00:00.000Z",
      "goal_seconds": 900,
      "verified_seconds": 0,
      "verified_before_alarm_seconds": 0,
      "total_seconds": 0,
      "goal_reached_at": null,
      "self_reported_at": null,
      "alarm_at": "2026-10-14T23:02:11.000Z",
      "rescored": false,
      "sessions": []
    },
    {
      "day_key": "2026-10-15",
      "result": "pending",
      "window_start": "2026-10-15T09:00:00.000Z",
      "window_end": "2026-10-16T09:00:00.000Z",
      "goal_seconds": 900,
      "verified_seconds": 0,
      "verified_before_alarm_seconds": 0,
      "total_seconds": 0,
      "goal_reached_at": null,
      "self_reported_at": null,
      "alarm_at": null,
      "rescored": false,
      "sessions": []
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `from`, `to` | day key | The resolved range. |
| `days` | array | Days that have a scored window or any verified reading, ascending by `day_key`. Days with neither are omitted. |
| `days[].day_key` | day key | |
| `days[].result` | `pending` \| `feast` \| `missed`, *nullable* | `null` = no scored window (history-only reading, e.g. before the first day). |
| `days[].window_start`, `window_end` | timestamp, *nullable* | `null` when `result` is `null`. |
| `days[].goal_seconds` | integer, *nullable* | Goal of that day. `null` when `result` is `null`. |
| `days[].verified_seconds` | integer | Scored reading credited to the day (0 when `result` is `null`). |
| `days[].verified_before_alarm_seconds` | integer | The part of `verified_seconds` anchored at or before `alarm_at`. Equals `verified_seconds` when `alarm_at` is `null` (no alarm fired in the window yet, or none landed in it). 0 when `result` is `null`. |
| `days[].total_seconds` | integer | All verified reading filed under the day, including history-only pieces (`backdated`, `stale`, pre-first-day). Use for "minutes read". |
| `days[].goal_reached_at` | timestamp, *nullable* | |
| `days[].self_reported_at` | timestamp, *nullable* | A self-report day shows as a feast in the calendar. |
| `days[].alarm_at` | timestamp, *nullable* | The fired alarm that decided the day. |
| `days[].rescored` | boolean | A late offline session flipped this day from missed to feast. |
| `days[].sessions` | array | Verified session pieces filed under the day, by start time. |
| `sessions[].id` | UUID | Piece id (the client id for the first piece of a session). |
| `sessions[].session_id` | UUID | The client session id this piece belongs to (pieces of a split session share it). |
| `sessions[].source` | enum | `reader`, `self_report`, `audio`. |
| `sessions[].server_start_at`, `server_end_at` | timestamp | Anchored server instants (equal for a self-report). |
| `sessions[].active_seconds` | integer | Seconds credited to this piece. |
| `sessions[].scorable` | boolean | `false` for history-only (`backdated` / `stale`). |
| `sessions[].scored` | boolean | Counted toward a scored day. |
| `sessions[].reason` | `backdated` \| `stale`, *nullable* | |
| `sessions[].content_ref` | string, *nullable* | As uploaded. |

Errors: `400 invalid_request`, `400 invalid_range`, `400 range_too_large`.

---

## POST /api/v1/devices

Registers (or refreshes) this device's APNs token. Only call it when `alarmMode == .push`.

Request:

```json
{ "token": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", "environment": "sandbox" }
```

| Field | Type | Rules |
|---|---|---|
| `token` | string | APNs device token, hex, 64 to 200 chars (case-insensitive). |
| `environment` | `sandbox` \| `production` | `sandbox` for Xcode/debug builds, `production` for TestFlight/App Store. |

Response `200`:

```json
{
  "device": {
    "device_id": "1e52007a-98a2-42c9-ba94-87efaf2f2dc3",
    "environment": "sandbox",
    "token_suffix": "6d7e8f90",
    "registered_at": "2026-10-13T04:41:00.000Z"
  },
  "home": { "...": "full GET /home payload" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `device.device_id` | UUID | The token's device. |
| `device.environment` | enum | As sent. |
| `device.token_suffix` | string | Last 8 hex chars, for display/debug. |
| `device.registered_at` | timestamp | |
| `home` | object | Full `GET /home` payload. |

---

## GET /api/v1/alarm/today

The shared moment for today's Denver date. Time and counts are `null` until the alarm fires.
Call it when the alarm notification arrives (`AlarmMomentSheet`).

Response `200` (not yet fired):

```json
{ "alarm_date": "2026-10-13", "fired": false, "fired_at": null, "beat_count": null, "reader_count": null, "beat_pct": null }
```

Response `200` (fired):

```json
{ "alarm_date": "2026-10-13", "fired": true, "fired_at": "2026-10-13T20:47:01.204Z", "beat_count": 62, "reader_count": 100, "beat_pct": 62 }
```

Fields: as `home.alarm` above.

---

## GET /api/v1/dev/today-alarm (development only)

Returns today's secret alarm instant so the simulator's local notification can fire at the
exact instant the server scores against. Returns `404 not_found` unless the server runs with
`DEV_REVEAL_ALARM=true` (never in production). Requires the bearer token.

Response `200`:

```json
{
  "alarm_date": "2026-10-13",
  "fire_at": "2026-10-13T20:47:00.000Z",
  "fired_at": null,
  "window_start": "2026-10-13T16:00:00.000Z",
  "window_end": "2026-10-14T02:30:00.000Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `alarm_date` | alarm date | Today in America/Denver. |
| `fire_at` | timestamp, *nullable* | The scheduled instant. `null` when today's alarm has not been picked yet (the server picks it at ~15:00 UTC). Poll again after that and reschedule the local notification if it changed. |
| `fired_at` | timestamp, *nullable* | Set once fired. |
| `window_start`, `window_end` | timestamp, *nullable* | 10:00 and 20:30 Denver on that date. `null` with `fire_at`. |

---

## DELETE /api/v1/account

Deletes the user and all of their data (settings, days, sessions, stats, missed meals, device
credentials, push tokens). The token stops working immediately (`401`). The app then wipes local
data and the Keychain identity.

Response `200`:

```json
{ "deleted": true, "user_id": "37931f9e-bde7-4789-b4d0-34c2ed12364f" }
```

---

## Alarm push payload (APNs, phase 1 after enrollment)

The push uses the same `userInfo` keys as the dev local notification, so handler code does not
change. `apns-collapse-id: alarm-<alarm_date>`, `apns-priority: 10`, expires 15 min after firing.

```json
{
  "aps": {
    "alert": { "title": "The alarm went off", "body": "It went off at 2:47 PM before today's reading was done. Reading now still counts toward your history." },
    "sound": "default",
    "interruption-level": "time-sensitive",
    "content-available": 1,
    "thread-id": "daily-alarm"
  },
  "kind": "alarm",
  "alarm_date": "2026-10-13",
  "fired_at": "2026-10-13T20:47:01.204Z",
  "beat_pct": 62
}
```

| `kind` | Sent to | `aps` differences |
|---|---|---|
| `alarm` | Users whose open day contains the alarm and who were not safe at fire time. | `time-sensitive`, sound. |
| `safe` | Users already safe at fire time. Title "You're safe today". | `interruption-level: active`, no sound. |
| `moment` | Everyone else seen in the last 7 days (e.g. far zones whose day did not contain the alarm). Title "The alarm went off at 2:47 PM". | `interruption-level: active`, no sound. |

`beat_pct` is an integer or `null`. The push is best effort and reflects the server's
knowledge at fire time; always refetch `GET /home` and trust it over the push.

---

## Server-only endpoints (not for the app)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/cron/alarm` | `Bearer $CRON_SECRET` | Vercel Cron 15:00 UTC: start today's alarm workflow (idempotent). Response `{name, run_date, started, workflow_run_id}`. |
| `GET /api/cron/rollover` | `Bearer $CRON_SECRET` | Vercel Cron 00:00 UTC: start the 24-tick hourly sweep workflow. Same response shape. |
| `POST /api/admin/alarm/fire-now` `{alarm_date?}` | `Bearer $ADMIN_SECRET` | Fire today's existing alarm row now (scoring keeps the stored instant) and run the push fan-out. |
| `POST /api/admin/alarm/seed` `{fire_at, alarm_date?, start_workflow?}` | `Bearer $ADMIN_SECRET` | Local development only (`403` when `VERCEL_ENV=production`): override today's unfired instant and start an alarm workflow that sleeps until it. |
| `POST /api/admin/rollover/close-now` | `Bearer $ADMIN_SECRET` | Run one sweep tick now (alarm self-heal, close due days, dormancy). |
| `POST /api/admin/users/:id/recompute` | `Bearer $ADMIN_SECRET` | Full refold of one user's stats from the day log. |
