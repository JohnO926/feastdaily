import Foundation
import Testing
@testable import FeastCore

@Suite("Day model and alarm window")
struct DayModelTests {
    let denver = TimeZone(identifier: "America/Denver")!

    func date(_ s: String, _ tz: TimeZone) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = tz
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.date(from: s)!
    }

    @Test func rolloverAtThreeAM() {
        let model = DayModel(rolloverHour: 3, timeZone: denver)
        #expect(model.dayKey(for: date("2026-10-12 02:59:59", denver)).description == "2026-10-11")
        #expect(model.dayKey(for: date("2026-10-12 03:00:00", denver)).description == "2026-10-12")
        #expect(model.dayKey(for: date("2026-10-12 23:59:00", denver)).description == "2026-10-12")
    }

    @Test func ordinaryDayIs24Hours() {
        let model = DayModel(rolloverHour: 3, timeZone: denver)
        let b = model.bounds(of: DayKey("2026-10-12")!)
        #expect(b.upperBound.timeIntervalSince(b.lowerBound) == 24 * 3600)
    }

    @Test func springForwardDayIs23Hours() {
        let model = DayModel(rolloverHour: 3, timeZone: denver)
        let b = model.bounds(of: DayKey("2026-03-07")!)
        #expect(b.upperBound.timeIntervalSince(b.lowerBound) == 23 * 3600)
        #expect(model.dayKey(for: b.upperBound).description == "2026-03-08")
    }

    @Test func fallBackDayIs25Hours() {
        let model = DayModel(rolloverHour: 3, timeZone: denver)
        let b = model.bounds(of: DayKey("2026-10-31")!)
        #expect(b.upperBound.timeIntervalSince(b.lowerBound) == 25 * 3600)
    }

    @Test func nextRolloverIsStrictlyAfter() {
        let model = DayModel(rolloverHour: 3, timeZone: denver)
        let atRollover = date("2026-10-12 03:00:00", denver)
        #expect(model.nextRollover(after: atRollover) == date("2026-10-13 03:00:00", denver))
        #expect(model.nextRollover(after: date("2026-10-12 02:00:00", denver)) == atRollover)
    }

    @Test func midnightRollover() {
        let model = DayModel(rolloverHour: 0, timeZone: denver)
        #expect(model.dayKey(for: date("2026-10-12 00:00:00", denver)).description == "2026-10-12")
    }

    @Test func dayKeyArithmetic() {
        #expect(DayKey("2026-12-31")!.adding(days: 1).description == "2027-01-01")
        #expect(DayKey("2026-03-01")!.adding(days: -1).description == "2026-02-28")
        #expect(DayKey("2026-10-12")! < DayKey("2026-10-13")!)
        #expect(DayKey("2026-13-01") == nil)
    }

    @Test func alarmWindowFollowsDaylightSaving() {
        let w = AlarmWindow.standard
        let summer = w.interval(on: DayKey("2026-07-01")!)
        let winter = w.interval(on: DayKey("2026-12-01")!)
        let utc = TimeZone(identifier: "UTC")!
        #expect(Calendar.gregorian(in: utc).component(.hour, from: summer.start) == 16)  // MDT = UTC-6
        #expect(Calendar.gregorian(in: utc).component(.hour, from: winter.start) == 17)  // MST = UTC-7
        #expect(summer.duration == 10.5 * 3600)
    }

    @Test func randomAlarmsStayInsideTheWindow() {
        var rng = SeededGenerator(seed: 7)
        let w = AlarmWindow.standard
        var key = DayKey("2026-01-01")!
        for _ in 0..<400 {
            let i = w.interval(on: key)
            let t = w.randomInstant(on: key, using: &rng)
            #expect(t >= i.start && t < i.end)
            #expect(w.alarmDate(for: t) == key)
            key = key.adding(days: 1)
        }
    }

    @Test func windowFromServerConfig() {
        let w = AlarmWindow(start: "10:00", end: "20:30", timeZoneIdentifier: "America/Denver")
        #expect(w == .standard)
        #expect(AlarmWindow(start: "10", end: "20:30", timeZoneIdentifier: "America/Denver") == nil)
    }

    @Test func goalOptionsMatchTheRequirements() {
        let g = ScoringDisplay.goalOptions
        #expect(g.first == 45)
        #expect(g.last == 2_700)
        #expect(g.contains(285) && g.contains(300) && g.contains(360))
        #expect(!g.contains(315))
        #expect(ScoringDisplay.goalLabel(seconds: 45) == "45 sec")
        #expect(ScoringDisplay.goalLabel(seconds: 75) == "1:15")
        #expect(ScoringDisplay.goalLabel(seconds: 600) == "10 min")
    }
}
