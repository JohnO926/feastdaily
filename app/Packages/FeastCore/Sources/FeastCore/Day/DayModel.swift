import Foundation

/// Local day boundaries with a rollover hour (default 3 AM), so late-night reading counts for the day it belongs to.
///
/// The server is authoritative for a user's day windows (it applies the 12 h / 36 h travel clamp). The client
/// prefers the server's `today.window_start/window_end` and uses this model only before the first sync and for
/// planning notifications.
public struct DayModel: Sendable, Equatable {
    public var rolloverHour: Int
    public var timeZone: TimeZone

    public init(rolloverHour: Int = 3, timeZone: TimeZone = .current) {
        precondition((0...23).contains(rolloverHour), "rolloverHour must be 0...23")
        self.rolloverHour = rolloverHour
        self.timeZone = timeZone
    }

    /// The day an instant belongs to: its local date, or the previous date if before the rollover hour.
    public func dayKey(for date: Date) -> DayKey {
        let cal = Calendar.gregorian(in: timeZone)
        let hour = cal.component(.hour, from: date)
        let key = DayKey.calendarDate(of: date, in: timeZone)
        return hour < rolloverHour ? key.adding(days: -1) : key
    }

    /// `[start, end)` of a day: rollover on its date to rollover on the next date. 23 h or 25 h across DST.
    public func bounds(of key: DayKey) -> Range<Date> {
        let start = key.date(hour: rolloverHour, in: timeZone)
        let end = key.adding(days: 1).date(hour: rolloverHour, in: timeZone)
        return start..<end
    }

    public func nextRollover(after date: Date) -> Date {
        bounds(of: dayKey(for: date)).upperBound
    }
}
