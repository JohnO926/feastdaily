import Foundation

/// The window the shared daily alarm is drawn from: 10:00 to 20:30 America/Denver, following daylight saving.
///
/// The server picks the real instant and keeps it secret; the client uses this for the dev-only local
/// simulation, for display, and to know when "today's alarm has certainly fired".
public struct AlarmWindow: Sendable, Equatable {
    public var timeZone: TimeZone
    public var startHour: Int
    public var startMinute: Int
    public var endHour: Int
    public var endMinute: Int

    public static let standard = AlarmWindow(
        timeZone: TimeZone(identifier: "America/Denver")!,
        startHour: 10, startMinute: 0, endHour: 20, endMinute: 30
    )

    public init(timeZone: TimeZone, startHour: Int, startMinute: Int, endHour: Int, endMinute: Int) {
        self.timeZone = timeZone
        self.startHour = startHour
        self.startMinute = startMinute
        self.endHour = endHour
        self.endMinute = endMinute
    }

    /// Builds a window from the server's `config.alarm_window` (`"10:00"`, `"20:30"`, `"America/Denver"`).
    public init?(start: String, end: String, timeZoneIdentifier: String) {
        func hm(_ s: String) -> (Int, Int)? {
            let p = s.split(separator: ":").compactMap { Int($0) }
            return p.count == 2 ? (p[0], p[1]) : nil
        }
        guard let tz = TimeZone(identifier: timeZoneIdentifier), let s = hm(start), let e = hm(end) else { return nil }
        self.init(timeZone: tz, startHour: s.0, startMinute: s.1, endHour: e.0, endMinute: e.1)
    }

    /// The Denver calendar date an instant falls on (the server's `alarm_date`).
    public func alarmDate(for date: Date) -> DayKey {
        DayKey.calendarDate(of: date, in: timeZone)
    }

    public func interval(on alarmDate: DayKey) -> DateInterval {
        let start = alarmDate.date(hour: startHour, minute: startMinute, in: timeZone)
        let end = alarmDate.date(hour: endHour, minute: endMinute, in: timeZone)
        return DateInterval(start: start, end: end)
    }

    /// A uniformly random instant in the window, rounded down to the second. Used only by the dev simulation.
    public func randomInstant<G: RandomNumberGenerator>(on alarmDate: DayKey, using generator: inout G) -> Date {
        let i = interval(on: alarmDate)
        let offset = Double.random(in: 0..<i.duration, using: &generator).rounded(.down)
        return i.start.addingTimeInterval(offset)
    }
}
