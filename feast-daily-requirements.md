# Feast Daily: iOS App Requirements

Last updated: October 6, 2026

## Overview and goals

A native iOS app that gets people reading scripture every day by racing a daily alarm. Each user sets a reading goal (45 seconds to 45 minutes). Once a day, at a random moment between 10:00 AM and 8:30 PM Mountain Time (following daylight saving), the alarm goes off for everyone at once, BeReal style. Finish the goal before the alarm and it's a feast; miss it and it's a missed meal. Feasts, streaks, and missed meals feed a global leaderboard and private boards.

Name: Feast Daily, from 2 Nephi 32:3 ("feast upon the words of Christ"); confirm availability in App Store Connect at enrollment. Launch content: the Latter-day Saint standard works. The app is free, anonymous, and has no rest days: the point is daily reading.

Goals:

- Build a daily habit, even when the day's reading is under a minute.
- Make missing a day cost something without making the app feel punishing.
- Give families, friends, and groups a reason to keep each other going.

Non-goals for v1: study tools (notes, cross references, commentary), Android, and web.

Long-term vision: if the app takes off and proves effective, offer it to the Church to fold into Gospel Library.

## Core loop and the alarm mechanic

Every day is a race against an alarm nobody can see coming. The day is "won" the moment cumulative reading time hits the goal before the alarm goes off.

User settings:

- Reading goal: 45 seconds to 45 minutes, in 15 second steps under 5 minutes and 1 minute steps above.
- Alarm time: set by the app, not the user. One random moment each day between 10:00 AM and 8:30 PM Mountain Time, following daylight saving, the same moment for every user wherever they live, revealed only when it goes off. Regional windows may come later.
- Morning reminder: optional, at a time the user picks, to read before the alarm window opens.
- No rest days: the alarm runs every day, Sundays included, with no blocked hours.
- Day rollover: default 3:00 AM local, so late night reading counts for the day it belongs to.

Daily flow:

1. Day opens at rollover. The server picks today's alarm time at random within the window and keeps it secret.
2. The user reads in the in-app reader any time. Reading time accumulates across sessions; it does not have to be one sitting. Finishing before 10:00 AM is always a feast.
3. Goal hit before the alarm: the day is a feast. When the alarm fires, the user gets a quiet "You're safe today" instead of an alarm.
4. Goal not hit: the alarm fires as a time-sensitive notification and the day is a missed meal. Reading afterward still logs to history.
5. Right after the alarm, everyone sees the shared moment: what time it went off and what percent of readers beat it.
6. At rollover the day closes, feast streaks and missed meals update, and leaderboards update.

Changing the reading goal takes effect the next day, never mid-day, so nobody moves the finish line after the race starts. Because there's no safe time to procrastinate, the winning habit is reading first thing in the morning.

## Scoring: feasts and missed meals

There is no margin in either direction. How early you read or how late you finish doesn't matter; each day is either a feast or a missed meal. The food language plays off the name; Famine comes from Amos 8:11, a famine of hearing the words of the Lord.

| Result | When | Effect |
| --- | --- | --- |
| Feast | Reading goal completed before the alarm | Feast streak +1, feasts +1, counts toward restoring a missed meal |
| Missed meal | Alarm goes off before the goal is completed | Feast streak resets to 0, missed meals +1 |

Missed meals:

- Each missed meal clears 30 days after it happened.
- 4 feasts in a row restore one missed meal early.
- 3 or more active missed meals puts you in Famine: you rank at the bottom of every board and streak milestones pause until you're back under 3.

Reading after the alarm still counts as reading. It logs to history and reading plans, but the day stays a missed meal. The app should never make reading feel pointless.

Edge cases to handle:

- Never finished: a missed meal at rollover, same as finishing late.
- Travel and time zones: the alarm is one shared moment, so travel doesn't move it; rollover follows local time, and a day can't be shortened below 12 hours or lengthened past 36.
- Device clock changes: feast or missed meal is decided by server time, not the phone's clock.
- Goal changes: apply at the next rollover.
- New users: their first scored day starts at the first rollover after sign up.

## Reading verification and anti-cheat

The leaderboard only means something if reading time is real, so the in-app reader tracks time automatically and can't be gamed by starting a timer and pocketing the phone. Reading anywhere else is self-reported on the honor system.

The timer counts when all of these are true:

- The reader is in the foreground and the screen is on.
- There has been interaction (scroll, page turn, tap) within the last 60 seconds; otherwise it pauses with a gentle "still reading?" prompt.
- Pace is plausible: page turns faster than roughly 3 seconds per screen of text don't accrue time.

Other sources of reading:

- Audio mode: counts while audio is actually playing at 1x to 2x speed. Shown with an audio icon on leaderboards.
- Self-report (v1): for reading outside the app (Gospel Library, paper scriptures), the user taps "I read today." An honesty screen with some humor asks them to confirm, for example "Thou shalt not bear false witness, not even against thine own streak." It counts as a feast on every board, on the honor system.
- Gospel Library via Screen Time (phase 3, not v1): with the user's permission, Apple's Screen Time API reports when they hit their goal time in an app they pick. It needs an Apple-approved Family Controls entitlement, can't confirm the app picked is Gospel Library, and counts all app time, not just scripture.

Server side checks: feasts and missed meals decided from server timestamps, sessions uploaded with monotonic clock data, and outliers (for example 45 minutes logged in 5 minutes of wall time) rejected.

## Leaderboard design

Boards rank on consistency: who reads every day, not who reads earliest.

Ranking order (all boards):

1. Fewest active missed meals first; anyone in Famine drops to the bottom.
2. Then current streak, longest first.
3. Tie break: feasts this week (all-time feasts on the all-time view).

Board scopes:

| Board | Who's on it | Resets | Default |
| --- | --- | --- | --- |
| Global | Every user, by anonymous handle | Weekly, with all-time view | On |
| Private boards | Anyone with the invite code; any user can create one and is its admin | Weekly, with all-time view | On when joined |

A user can be on as many private boards as they like (family, friends, a class, a quorum). Admins can rename the board, rotate the invite code, and remove members. Leagues could be added later if the global board gets too big to feel winnable.

Why weekly resets: someone who fell behind can still win this week, which keeps the board motivating for the people who need it most. The all-time view preserves bragging rights.

Private board views to include: the group's total feasts this week, percent of members who beat the alarm today, and a live "who's done today" list. Boards show handles, streaks, missed meals, and feasts.

## Gamification system

Missed meals are the stick; everything else here is the carrot. The goal is that people open the app because they want to, not just to silence an alarm.

| Mechanic | How it works | Why it matters |
| --- | --- | --- |
| Feast streak | Consecutive feasts; any missed meal resets it | Simplest daily motivator |
| Missed meal marks | Marks next to your handle and on the widget | Makes a miss visible without shaming |
| Back at the Table badge | Awarded for climbing out of Famine | Rewards recovery, the hardest part |
| Milestones | 7, 30, 100, 365 day streaks; first book finished; every chapter of a volume | Long term goals past the daily race |
| Reading plans | Optional guided plans (a book in 30 days, etc.) with progress rings | Gives each session a purpose |
| Board challenges | A private board sets a target (for example, 90% of members feast 7 days straight) | Shared stakes, social pull |
| Nudges | A friend can send one "you've got this" per day to someone who hasn't read yet | Accountability without nagging |
| Accountability partner | Opt in, with someone on a shared private board; they're notified when you miss a meal | Strong commitment device for serious users |
| Daily verse card | Shareable image of a verse you read today | Organic growth |

Feasts are the currency: lifetime feasts unlock cosmetic rewards such as reader themes, fonts, handle colors, and badge frames. Nothing can buy off a missed meal.

Tone guardrails: no shaming copy and no paid items that remove missed meals. Selling streak repair would undercut the whole point.

## Functional requirements

P1 ships in the MVP; P2 follows in phase 2; P3 later.

| ID | Area | Requirement | Priority |
| --- | --- | --- | --- |
| FR-01 | Onboarding | Anonymous sign-in (Sign in with Apple once enrolled); pick goal, rollover, morning reminder | P1 |
| FR-02 | Reader | Paginated and scroll modes, font size, dark mode, resume where you left off | P1 |
| FR-03 | Reader | Verified in-app reading timer, plus an "I read today" self-report with a humorous honesty screen | P1 |
| FR-04 | Alarm | Random daily alarm, same moment for all users, picked and pushed by the server; readers who already beat it get a quiet result instead | P1 |
| FR-05 | Alarm | Optional morning reminder at a user-set time | P1 |
| FR-06 | Scoring | Server-decided feast or missed meal, streak, missed meal restoring and expiry at rollover | P1 |
| FR-07 | Home | Today's status (safe or exposed), progress ring, feast streak, missed meal marks, today's alarm time once revealed | P1 |
| FR-08 | Widget | Home and lock screen widgets with today's status, feast streak, and missed meals | P1 |
| FR-09 | History | Calendar of feasts, missed meals, minutes read | P1 |
| FR-10 | Social | Generated anonymous handle; global board | P2 |
| FR-11 | Social | Private boards: create, invite code, admin controls, board stats | P2 |
| FR-12 | Social | Nudges and accountability partner | P2 |
| FR-13 | Gamification | Badges, milestones, Back at the Table badge, cosmetic unlocks from feasts | P2 |
| FR-14 | Content | Reading plans with progress | P2 |
| FR-15 | Reader | Audio mode with verified listening time | P3 |
| FR-16 | Social | Leagues (only if the global board needs it) | P3 |
| FR-17 | Platform | Apple Watch complication and haptic alarm | P3 |
| FR-18 | Admin | Dashboard to tune missed meal expiry, restoring, and Famine thresholds without an app update | P2 |

## Technical architecture

SwiftUI app with a thin, server-authoritative backend. The phone records reading sessions; the server decides feasts, missed meals, and rankings so nobody can edit their way up the board.

| Layer | Choice | Notes |
| --- | --- | --- |
| App | Swift + SwiftUI, iOS 17 minimum | Widgets, Live Activities, and AlarmKit require Swift; React Native would still need native code for the core features |
| Alarm | Server picks a random time; delivered as a time-sensitive push to every device at once | The time can't sit on the phone in advance or it could be found. Push breaks through Focus but not silent mode, same as BeReal |
| Scripture text | Bundled read-only SQLite with full-text search | Converted once from the public domain JSON; offline, instant search |
| Local user data | SwiftData | Offline reading; sessions queue and sync later |
| Widgets | WidgetKit + App Group | Lock screen shows whether you're safe today |
| Auth | Supabase anonymous sign-in during development; add Sign in with Apple at enrollment | Server keeps only an opaque user ID; no name or email stored |
| Backend | Supabase: Postgres, edge functions, scheduled jobs, row-level security | One-person operable; plain Postgres, so a later move to AWS is straightforward |
| Scoring | Postgres functions on an hourly scheduled job | Closes the day for users whose 3 AM rollover just passed; server is the only source of truth |
| Leaderboards | Postgres ranking queries; Game Center not used | Game Center can't do private boards or tiered ranking |
| Push | APNs directly from an edge function | Core feature: delivers the daily alarm, plus nudges; requires paid Apple membership |
| Shortcuts | App Intents | "Hey Siri, start my reading" |
| Analytics / crashes | TelemetryDeck + Xcode Organizer | No ad SDKs |
| Build and release | Xcode + Claude Code via xcodebuild; Xcode Cloud once enrolled | Claude Code writes and builds the whole app |

Offline rule: sessions read offline still count if they sync within 48 hours, using the device's monotonic timestamps checked against server receipt time.

## Development without a paid Apple account

Build phase 1 for free with an Xcode Personal Team (sign in with a regular Apple ID) on a personal iPhone and the simulator. Pay the $99 per year Apple Developer Program when other people need to test or when it's time to test the real push alarm.

| Works free | Needs paid membership |
| --- | --- |
| Running on your own iPhone and simulator | TestFlight and installing on other people's phones |
| App Groups (widget data sharing), background modes | Push notifications (the real daily alarm, nudges) |
| Local notifications (pre-alarm reminders) | Sign in with Apple |
| A local random alarm that simulates the daily alarm during development | App Store distribution |

Free tier limits: up to 10 App IDs, and installed builds expire after 7 days, so rebuild and reinstall weekly.

Enrollment: decide individual vs organization. Individual shows your personal name as seller; organization shows the LLC name but needs a D-U-N-S number, which can take a couple of weeks. Request it early if publishing under an LLC.

## Content and licensing

Because verified time requires an in-app reader, the app has to host scripture text, and that text is often copyrighted. Settle this before design work.

- Verse text: [Scriptures in JSON](https://bencrowder.net/scriptures-in-json/) by Ben Crowder covers all five volumes (Old Testament, New Testament, Book of Mormon, Doctrine and Covenants, Pearl of Great Price) and is released into the public domain. It leaves out footnotes, chapter summaries, and the Book of Mormon introduction because those are copyrighted. Spot check it against the current edition, since the text has had small revisions over the years.
- Scraping churchofjesuschrist.org is not an option. Its [terms of use](https://newsroom.churchofjesuschrist.org/rights-and-use) allow only your own personal, noncommercial use. A free app is noncommercial but not personal: it distributes the text to the public. The terms also require written permission to copy material to another network or for use by an organization or legal entity, and they ban scrapers outright.
- Footnotes, chapter summaries, study helps, audio, and art need permission from the Church's [Intellectual Property Office](https://tech.churchofjesuschrist.org/wiki/Intellectual_Property_Office). Expect a review of a demo build and real odds of a no; earlier third-party scripture apps have been refused or pulled.
- For the full study experience, deep link a chapter into Gospel Library. Linking is fine; copying is not.
- Branding: don't use Church names, logos, or anything that implies the app is official. Those are trademarks too.

Plan: ship v1 on the public domain verse text only. Chapter summaries are a later version item; if pursued, request permission through the [permissions site](https://permissions.churchofjesuschrist.org/), once there's a working build to show; replies take about 45 days. Have an IP attorney review the content plan before launch.

## Privacy, data, and analytics

Reading habits in a scripture app reveal religious belief, which GDPR and several US state laws treat as sensitive data. Default to private and collect the minimum.

- Anonymous by design: every user gets a generated handle (for example QuietCedar42) and can reroll it, but can't type one. No photos, chat, or direct messages, so there's nothing to moderate and no way to share personal details.
- Collect only what scoring needs: opaque user ID, time zone, settings, reading sessions. No birthdate, name, email, or location.
- Not asking ages doesn't remove age obligations. Utah's App Store Accountability Act, as amended in March 2026, requires developers starting May 6, 2027 to check a user's age category through the app store's signals and confirm parental consent before enforcing terms against a minor. Enforcement is now by private lawsuit, not the attorney general. Texas, Louisiana, and California have similar laws. Plan to read Apple's age range signal and use it only for compliance and safety defaults. Sources: [Utah Code 13-76-202](https://le.utah.gov/xcode/Title13/Chapter76/C13-76-S202_2026031820260318.html), [Wiley summary](https://www.wileyconnect.com/utah-amends-app-store-accountability-act-asaa-key-obligations-delayed-until-may-6-2027).
- COPPA still applies if the app is directed at kids under 13 or learns a user is under 13. Collecting no personal information keeps exposure low, but get a privacy attorney's review before launch.
- Nudges and accountability partners only work between members of the same private board.
- Full account and data deletion in app, plus App Store privacy label and privacy policy before TestFlight.

Metrics to track: day 7 and day 30 retention, percent of active users beating the alarm daily, average active missed meals, recovery rate (share of users who leave Famine within 14 days), and private board join rate.

## MVP scope and phasing

Ship the solo loop first and prove people come back before building social features. Each phase has a gate to move on.

| Phase | Scope | Gate to next phase |
| --- | --- | --- |
| 1. Solo MVP | FR-01 to FR-09: reader, timer, alarm, feasts, streaks, missed meals, widgets, history; public domain text | 50+ TestFlight users, 40%+ still beating the alarm on day 30 |
| 2. Social | FR-10 to FR-14, FR-18: global board, private boards, nudges, badges, reading plans, admin tuning | Private boards averaging 5+ active members; missed meal rules tuned on real data |
| 3. Scale | FR-15 to FR-17: audio, leagues if needed, Apple Watch; Gospel Library time via Screen Time; chapter summaries if permission is granted; regional alarm windows | Licensing secured; moderation plan for public boards |

## Open questions

- [ ] Time zone: decided. Mountain Time following daylight saving, window 10:00 AM to 8:30 PM.
- [ ] Users outside Mountain Time: decided. One Mountain Time schedule for everyone in v1 (12:00 PM to 10:30 PM on the East Coast); consider regional windows later.
- [ ] Sundays: decided. The alarm can go off any time in the window, Sunday meeting hours included.
- [ ] Beat credit: decided. Margin is dropped in both directions; each day is a feast or a missed meal.
- [ ] Missed meal thresholds: decided as launch defaults. 3 missed meals for Famine, 30 day expiry, and 4 feasts to restore one; tunable from the admin dashboard.
- [ ] Outside reading: decided. Self-report counts everywhere on the honor system; no Screen Time in v1.
- [ ] Chapter summaries: decided. Text only for now; revisit in a later version.
- [ ] App name: decided. Feast Daily, with branding that can't be mistaken for an official Church app.
- [ ] Privacy attorney review on COPPA and the Utah age signal requirements before launch

## Notes for Claude Code

Suggested build order for phase 1, each step testable on its own:

1. Data pipeline: script that converts the Scriptures in JSON files into a bundled SQLite database with an FTS5 search index.
2. Xcode project: SwiftUI app target, widget extension, shared App Group, signed with the free Personal Team.
3. Reader: book and chapter navigation, paginated and scroll modes, resume position.
4. Verified timer: foreground, interaction, and pace rules from the verification section, with unit tests.
5. Supabase schema: users, settings, reading_sessions, daily_results, with row-level security and anonymous auth.
6. Scoring: Postgres function that marks each day a feast or a missed meal and updates feast streaks, missed meal expiry, restoring, and Famine, plus an hourly scheduled job for rollover. Unit test the missed meal rules.
7. Alarm: server function that picks a secret random time in the 10:00 AM to 8:30 PM Mountain Time window (following daylight saving) each day and fires a time-sensitive push to all devices. During free-tier development, simulate it with a local random notification. Add the optional morning reminder.
8. Home screen, history calendar, and widgets.

Keep all scoring constants (missed meal expiry, restoring, Famine threshold) in a server-side config table so they can be tuned without an app update.
