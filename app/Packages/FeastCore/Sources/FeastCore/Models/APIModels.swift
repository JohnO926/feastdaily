import Foundation

// Wire models for the Feast Daily API. Keys are snake_case on the wire; `FeastJSON` converts them.
// The server contract is documented in server/API.md.

public enum DayStatus: String, Codable, Sendable, Equatable {
    case notStarted = "not_started"
    case racing
    case safe
    case missed
}

public enum DayResult: String, Codable, Sendable, Equatable {
    case pending, feast, missed
}

public enum SessionSource: String, Codable, Sendable, Equatable {
    case reader
    case selfReport = "self_report"
    case audio
}

public struct SettingsDTO: Codable, Sendable, Equatable {
    public var tz: String
    public var rolloverHour: Int
    public var goalSeconds: Int
    public var pendingGoalSeconds: Int?
    public var reminderEnabled: Bool
    /// `HH:mm` in the user's local time zone.
    public var reminderLocalTime: String?

    public init(tz: String, rolloverHour: Int, goalSeconds: Int, pendingGoalSeconds: Int? = nil,
                reminderEnabled: Bool, reminderLocalTime: String? = nil) {
        self.tz = tz
        self.rolloverHour = rolloverHour
        self.goalSeconds = goalSeconds
        self.pendingGoalSeconds = pendingGoalSeconds
        self.reminderEnabled = reminderEnabled
        self.reminderLocalTime = reminderLocalTime
    }
}

public struct TodayDTO: Codable, Sendable, Equatable {
    public var dayKey: DayKey
    public var windowStart: Date
    public var windowEnd: Date
    public var goalSeconds: Int
    public var verifiedSeconds: Int
    public var verifiedBeforeAlarmSeconds: Int?
    public var goalReachedAt: Date?
    public var selfReportedAt: Date?
    public var alarmAt: Date?
    public var status: DayStatus

    public init(dayKey: DayKey, windowStart: Date, windowEnd: Date, goalSeconds: Int, verifiedSeconds: Int,
                verifiedBeforeAlarmSeconds: Int? = nil, goalReachedAt: Date? = nil, selfReportedAt: Date? = nil,
                alarmAt: Date? = nil, status: DayStatus) {
        self.dayKey = dayKey
        self.windowStart = windowStart
        self.windowEnd = windowEnd
        self.goalSeconds = goalSeconds
        self.verifiedSeconds = verifiedSeconds
        self.verifiedBeforeAlarmSeconds = verifiedBeforeAlarmSeconds
        self.goalReachedAt = goalReachedAt
        self.selfReportedAt = selfReportedAt
        self.alarmAt = alarmAt
        self.status = status
    }
}

public struct AlarmDTO: Codable, Sendable, Equatable, Identifiable {
    public var id: String { alarmDate.description }
    public var alarmDate: DayKey
    public var fired: Bool
    public var firedAt: Date?
    public var beatCount: Int?
    public var readerCount: Int?
    public var beatPct: Double?

    public init(alarmDate: DayKey, fired: Bool, firedAt: Date? = nil, beatCount: Int? = nil,
                readerCount: Int? = nil, beatPct: Double? = nil) {
        self.alarmDate = alarmDate
        self.fired = fired
        self.firedAt = firedAt
        self.beatCount = beatCount
        self.readerCount = readerCount
        self.beatPct = beatPct
    }
}

public struct StatsDTO: Codable, Sendable, Equatable {
    public var currentStreak: Int
    public var longestStreak: Int
    public var totalFeasts: Int
    public var activeMissedMeals: Int
    public var famine: Bool
    public var restoreProgress: Int

    public init(currentStreak: Int = 0, longestStreak: Int = 0, totalFeasts: Int = 0,
                activeMissedMeals: Int = 0, famine: Bool = false, restoreProgress: Int = 0) {
        self.currentStreak = currentStreak
        self.longestStreak = longestStreak
        self.totalFeasts = totalFeasts
        self.activeMissedMeals = activeMissedMeals
        self.famine = famine
        self.restoreProgress = restoreProgress
    }
}

public struct MissedMealDTO: Codable, Sendable, Equatable {
    public var occurredAt: Date
    public var expiresAt: Date
}

public struct LastClosedDTO: Codable, Sendable, Equatable {
    public var dayKey: DayKey
    public var result: DayResult
}

public struct AlarmWindowDTO: Codable, Sendable, Equatable {
    public var start: String
    public var end: String
    public var tz: String
}

public struct ConfigDTO: Codable, Sendable, Equatable {
    public var famineThreshold: Int
    public var missedMealExpiryDays: Int
    public var feastsToRestore: Int
    public var alarmWindow: AlarmWindowDTO?

    public init(famineThreshold: Int = 3, missedMealExpiryDays: Int = 30, feastsToRestore: Int = 4,
                alarmWindow: AlarmWindowDTO? = nil) {
        self.famineThreshold = famineThreshold
        self.missedMealExpiryDays = missedMealExpiryDays
        self.feastsToRestore = feastsToRestore
        self.alarmWindow = alarmWindow
    }

    public var window: AlarmWindow {
        alarmWindow.flatMap { AlarmWindow(start: $0.start, end: $0.end, timeZoneIdentifier: $0.tz) } ?? .standard
    }
}

/// `GET /api/v1/home`.
public struct HomeStateDTO: Codable, Sendable, Equatable {
    public var serverNow: Date
    public var settings: SettingsDTO?
    public var today: TodayDTO?
    public var firstDayStartsAt: Date?
    public var alarm: AlarmDTO?
    public var stats: StatsDTO
    public var missedMeals: [MissedMealDTO]
    public var lastClosed: LastClosedDTO?
    public var config: ConfigDTO

    public init(serverNow: Date, settings: SettingsDTO? = nil, today: TodayDTO? = nil, firstDayStartsAt: Date? = nil,
                alarm: AlarmDTO? = nil, stats: StatsDTO = StatsDTO(), missedMeals: [MissedMealDTO] = [],
                lastClosed: LastClosedDTO? = nil, config: ConfigDTO = ConfigDTO()) {
        self.serverNow = serverNow
        self.settings = settings
        self.today = today
        self.firstDayStartsAt = firstDayStartsAt
        self.alarm = alarm
        self.stats = stats
        self.missedMeals = missedMeals
        self.lastClosed = lastClosed
        self.config = config
    }
}

/// One day in `GET /api/v1/history`.
public struct HistoryDayDTO: Codable, Sendable, Equatable, Identifiable {
    public var dayKey: DayKey
    public var result: DayResult?
    public var verifiedSeconds: Int
    public var selfReported: Bool
    public var alarmAt: Date?
    public var goalSeconds: Int?
    public var id: DayKey { dayKey }
}

public struct HistoryDTO: Codable, Sendable, Equatable {
    public var days: [HistoryDayDTO]
}

/// One session in the `POST /api/v1/sessions` envelope.
public struct SessionUploadDTO: Codable, Sendable, Equatable {
    public var id: UUID
    public var source: SessionSource
    public var bootId: String
    public var startedAtWall: Date
    public var endedAtWall: Date
    public var monoStartMs: Int64
    public var monoEndMs: Int64
    public var activeSeconds: Int
    public var contentRef: String?

    public init(id: UUID, source: SessionSource, bootId: String, startedAtWall: Date, endedAtWall: Date,
                monoStartMs: Int64, monoEndMs: Int64, activeSeconds: Int, contentRef: String? = nil) {
        self.id = id
        self.source = source
        self.bootId = bootId
        self.startedAtWall = startedAtWall
        self.endedAtWall = endedAtWall
        self.monoStartMs = monoStartMs
        self.monoEndMs = monoEndMs
        self.activeSeconds = activeSeconds
        self.contentRef = contentRef
    }
}

public struct SessionEnvelopeDTO: Codable, Sendable, Equatable {
    public var deviceId: UUID
    public var bootId: String
    public var clientNowWall: Date
    public var clientNowMonoMs: Int64
    public var sessions: [SessionUploadDTO]

    public init(deviceId: UUID, bootId: String, clientNowWall: Date, clientNowMonoMs: Int64,
                sessions: [SessionUploadDTO]) {
        self.deviceId = deviceId
        self.bootId = bootId
        self.clientNowWall = clientNowWall
        self.clientNowMonoMs = clientNowMonoMs
        self.sessions = sessions
    }
}

public enum SessionUploadStatus: String, Codable, Sendable { case accepted, duplicate, rejected }

public struct SessionResultDTO: Codable, Sendable, Equatable {
    public var id: UUID
    public var status: SessionUploadStatus
    public var reason: String?
    public var dayKey: DayKey?
    public var scored: Bool?
}

public struct SessionsResponseDTO: Codable, Sendable, Equatable {
    public var results: [SessionResultDTO]
    public var home: HomeStateDTO
}

public struct RegisterRequestDTO: Codable, Sendable {
    public var deviceId: UUID
    public var deviceSecret: String
    public init(deviceId: UUID, deviceSecret: String) {
        self.deviceId = deviceId
        self.deviceSecret = deviceSecret
    }
}

public struct RegisterResponseDTO: Codable, Sendable {
    public var userId: UUID
    public var token: String
}

public struct OnboardingRequestDTO: Codable, Sendable {
    public var tz: String
    public var rolloverHour: Int
    public var goalSeconds: Int
    public var reminderEnabled: Bool
    public var reminderLocalTime: String?
    public init(tz: String, rolloverHour: Int, goalSeconds: Int, reminderEnabled: Bool, reminderLocalTime: String?) {
        self.tz = tz
        self.rolloverHour = rolloverHour
        self.goalSeconds = goalSeconds
        self.reminderEnabled = reminderEnabled
        self.reminderLocalTime = reminderLocalTime
    }
}

/// `PATCH /api/v1/settings`. Every field is optional; omitted fields are unchanged.
public struct SettingsPatchDTO: Codable, Sendable {
    public var tz: String?
    public var rolloverHour: Int?
    public var goalSeconds: Int?
    public var reminderEnabled: Bool?
    public var reminderLocalTime: String?
    public init(tz: String? = nil, rolloverHour: Int? = nil, goalSeconds: Int? = nil,
                reminderEnabled: Bool? = nil, reminderLocalTime: String? = nil) {
        self.tz = tz
        self.rolloverHour = rolloverHour
        self.goalSeconds = goalSeconds
        self.reminderEnabled = reminderEnabled
        self.reminderLocalTime = reminderLocalTime
    }
}

/// Wraps the mutating endpoints that return `{ "home": ... }`.
public struct HomeEnvelopeDTO: Codable, Sendable {
    public var home: HomeStateDTO
}

public struct DevAlarmDTO: Codable, Sendable {
    public var alarmDate: DayKey
    public var fireAt: Date
}

/// JSON coding configured for the Feast Daily API.
public enum FeastJSON {
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            if let date = parseISO8601(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid date \(s)")
        }
        return d
    }

    public static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(formatISO8601(date))
        }
        return e
    }

    public static func parseISO8601(_ s: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }

    public static func formatISO8601(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}
