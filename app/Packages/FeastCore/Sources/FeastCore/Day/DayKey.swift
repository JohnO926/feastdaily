import Foundation

/// A calendar date used as a day identifier, serialized as `YYYY-MM-DD`.
///
/// The server's `day_key` for a user's day and the Denver `alarm_date` both use this format.
public struct DayKey: Hashable, Comparable, Sendable, CustomStringConvertible, Codable {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    public init?(_ string: String) {
        let parts = string.split(separator: "-")
        guard parts.count == 3,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d)
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    public static func < (lhs: DayKey, rhs: DayKey) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let key = DayKey(raw) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid day key \(raw)")
        }
        self = key
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    /// The calendar date of `date` in `timeZone`.
    public static func calendarDate(of date: Date, in timeZone: TimeZone) -> DayKey {
        let c = Calendar.gregorian(in: timeZone).dateComponents([.year, .month, .day], from: date)
        return DayKey(year: c.year!, month: c.month!, day: c.day!)
    }

    /// The day key `n` days after this one.
    public func adding(days n: Int) -> DayKey {
        let cal = Calendar.gregorian(in: TimeZone(identifier: "UTC")!)
        let base = cal.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
        return DayKey.calendarDate(of: cal.date(byAdding: .day, value: n, to: base)!, in: cal.timeZone)
    }

    /// Wall-clock `hour:minute` on this date in `timeZone`. DST gaps resolve forward, as `Calendar` does.
    public func date(hour: Int, minute: Int = 0, in timeZone: TimeZone) -> Date {
        Calendar.gregorian(in: timeZone).date(
            from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        )!
    }
}

extension Calendar {
    public static func gregorian(in timeZone: TimeZone) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }
}
