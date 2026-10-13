import Foundation
import Testing
@testable import FeastCore

@Suite("Today status resolver")
struct TodayStatusResolverTests {
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    var end: Date { start.addingTimeInterval(24 * 3600) }
    var alarm: Date { start.addingTimeInterval(10 * 3600) }
    let day = DayModel(rolloverHour: 3, timeZone: TimeZone(identifier: "America/Denver")!)

    func home(verified: Int, before: Int? = nil, status: DayStatus, alarmAt: Date? = nil,
              firstDay: Date? = nil) -> HomeStateDTO {
        HomeStateDTO(
            serverNow: start,
            settings: SettingsDTO(tz: "America/Denver", rolloverHour: 3, goalSeconds: 300, reminderEnabled: false),
            today: TodayDTO(dayKey: DayKey("2026-10-12")!, windowStart: start, windowEnd: end, goalSeconds: 300,
                            verifiedSeconds: verified, verifiedBeforeAlarmSeconds: before, alarmAt: alarmAt,
                            status: status),
            firstDayStartsAt: firstDay
        )
    }

    func resolve(_ h: HomeStateDTO?, _ local: [LocalSessionSummary], at now: Date) -> TodayDisplay {
        TodayStatusResolver.resolve(home: h, unsynced: local, fallbackGoalSeconds: 300, fallbackDay: day, now: now)
    }

    @Test func serverSafeIsSafe() {
        let r = resolve(home(verified: 300, status: .safe), [], at: start.addingTimeInterval(3600))
        #expect(r.status == .safe)
        #expect(r.progress == 1)
    }

    @Test func unsyncedReadingBeforeTheAlarmMakesItSafe() {
        let local = [LocalSessionSummary(source: .reader, activeSeconds: 200, endedAt: alarm.addingTimeInterval(-60))]
        let r = resolve(home(verified: 120, status: .racing), local, at: start.addingTimeInterval(9 * 3600))
        #expect(r.status == .safe)
        #expect(r.hasUnsynced)
    }

    @Test func afterTheAlarmOnlyPreAlarmLocalTimeCounts() {
        let local = [
            LocalSessionSummary(source: .reader, activeSeconds: 100, endedAt: alarm.addingTimeInterval(-60)),
            LocalSessionSummary(source: .reader, activeSeconds: 500, endedAt: alarm.addingTimeInterval(600)),
        ]
        let r = resolve(home(verified: 100, before: 100, status: .missed, alarmAt: alarm), local,
                        at: alarm.addingTimeInterval(1200))
        #expect(r.status == .missed)
        #expect(r.verifiedSeconds == 700)  // the ring still shows all reading
    }

    @Test func selfReportAfterTheAlarmIsAMiss() {
        let local = [LocalSessionSummary(source: .selfReport, activeSeconds: 0, endedAt: alarm.addingTimeInterval(60))]
        let r = resolve(home(verified: 0, status: .missed, alarmAt: alarm), local, at: alarm.addingTimeInterval(120))
        #expect(r.status == .missed)
    }

    @Test func selfReportBeforeTheAlarmIsSafe() {
        let local = [LocalSessionSummary(source: .selfReport, activeSeconds: 0, endedAt: alarm.addingTimeInterval(-60))]
        let r = resolve(home(verified: 0, status: .racing, alarmAt: alarm), local, at: alarm.addingTimeInterval(120))
        #expect(r.status == .safe)
    }

    @Test func syncedSessionsAreNotCountedTwice() {
        // The server already counts 200 s; nothing is unsynced.
        let r = resolve(home(verified: 200, status: .racing), [], at: start.addingTimeInterval(3600))
        #expect(r.verifiedSeconds == 200)
        #expect(r.status == .racing)
    }

    @Test func beforeTheFirstDayIsNotStarted() {
        let h = home(verified: 0, status: .notStarted, firstDay: start.addingTimeInterval(3600))
        #expect(resolve(h, [], at: start).status == .notStarted)
    }

    @Test func staleCacheAfterRolloverShowsAFreshDay() {
        let local = [LocalSessionSummary(source: .reader, activeSeconds: 40, endedAt: end.addingTimeInterval(600))]
        let r = resolve(home(verified: 300, status: .safe), local, at: end.addingTimeInterval(3600))
        #expect(r.status == .racing)
        #expect(r.verifiedSeconds == 40)
    }

    @Test func noServerStateUsesLocalOnly() {
        let local = [LocalSessionSummary(source: .reader, activeSeconds: 310, endedAt: start)]
        #expect(resolve(nil, local, at: start).status == .safe)
    }

    @Test func homeDecodesFromSnakeCaseJSON() throws {
        let json = """
        {"server_now":"2026-10-12T18:00:00.000Z",
         "settings":{"tz":"America/Denver","rollover_hour":3,"goal_seconds":300,"pending_goal_seconds":null,
                     "reminder_enabled":true,"reminder_local_time":"06:30"},
         "today":{"day_key":"2026-10-12","window_start":"2026-10-12T09:00:00.000Z","window_end":"2026-10-13T09:00:00.000Z",
                  "goal_seconds":300,"verified_seconds":120,"verified_before_alarm_seconds":120,
                  "goal_reached_at":null,"self_reported_at":null,"alarm_at":null,"status":"racing"},
         "first_day_starts_at":"2026-10-10T09:00:00.000Z",
         "alarm":{"alarm_date":"2026-10-12","fired":false},
         "stats":{"current_streak":4,"longest_streak":11,"total_feasts":40,"active_missed_meals":1,"famine":false,"restore_progress":2},
         "missed_meals":[{"occurred_at":"2026-10-01T20:00:00.000Z","expires_at":"2026-10-31T20:00:00.000Z"}],
         "last_closed":{"day_key":"2026-10-11","result":"feast"},
         "config":{"famine_threshold":3,"missed_meal_expiry_days":30,"feasts_to_restore":4,
                   "alarm_window":{"start":"10:00","end":"20:30","tz":"America/Denver"}}}
        """
        let h = try FeastJSON.decoder().decode(HomeStateDTO.self, from: Data(json.utf8))
        #expect(h.today?.status == .racing)
        #expect(h.stats.currentStreak == 4)
        #expect(h.config.window == .standard)
        #expect(h.lastClosed?.result == .feast)
    }

    @Test func envelopeEncodesSnakeCase() throws {
        let env = SessionEnvelopeDTO(deviceId: UUID(), bootId: "b", clientNowWall: start, clientNowMonoMs: 5,
                                     sessions: [SessionUploadDTO(id: UUID(), source: .selfReport, bootId: "b",
                                                                 startedAtWall: start, endedAtWall: start,
                                                                 monoStartMs: 1, monoEndMs: 1, activeSeconds: 0)])
        let s = String(decoding: try FeastJSON.encoder().encode(env), as: UTF8.self)
        #expect(s.contains("\"client_now_mono_ms\":5"))
        #expect(s.contains("\"source\":\"self_report\""))
        #expect(s.contains("\"started_at_wall\":\"2027-01-15T08:00:00.000Z\""))
    }

    @Test func widgetSnapshotRollsOver() {
        var s = WidgetSnapshot.placeholder
        s.status = .missed
        let next = s.rolledOver(nextRolloverAfter: s.nextRollover.addingTimeInterval(86_400))
        #expect(next.status == .racing)
        #expect(next.streak == 0)
        #expect(next.activeMissedMeals == s.activeMissedMeals + 1)
        s.status = .safe
        #expect(s.rolledOver(nextRolloverAfter: s.nextRollover).streak == s.streak + 1)
    }
}
