import Foundation

public enum AppGroup {
    public static let identifier = "group.com.valiflo.feastdaily"
    /// Keychain access group shared by the app and widget (prefixed with the team ID at build time).
    public static let keychainGroupSuffix = "com.valiflo.feastdaily.shared"
}

/// Everything the widget draws, written by the app into the App Group.
public struct WidgetSnapshot: Codable, Sendable, Equatable {
    public var generatedAt: Date
    public var dayKey: String
    public var status: DayStatus
    public var verifiedSeconds: Double
    public var goalSeconds: Int
    public var nextGoalSeconds: Int
    public var streak: Int
    public var activeMissedMeals: Int
    public var famine: Bool
    public var famineThreshold: Int
    public var alarmFiredAt: Date?
    /// End of today's alarm window; after it the alarm has certainly fired.
    public var alarmWindowEnd: Date
    public var nextRollover: Date
    public var resumeTitle: String?

    public init(generatedAt: Date, dayKey: String, status: DayStatus, verifiedSeconds: Double, goalSeconds: Int,
                nextGoalSeconds: Int, streak: Int, activeMissedMeals: Int, famine: Bool, famineThreshold: Int,
                alarmFiredAt: Date?, alarmWindowEnd: Date, nextRollover: Date, resumeTitle: String?) {
        self.generatedAt = generatedAt
        self.dayKey = dayKey
        self.status = status
        self.verifiedSeconds = verifiedSeconds
        self.goalSeconds = goalSeconds
        self.nextGoalSeconds = nextGoalSeconds
        self.streak = streak
        self.activeMissedMeals = activeMissedMeals
        self.famine = famine
        self.famineThreshold = famineThreshold
        self.alarmFiredAt = alarmFiredAt
        self.alarmWindowEnd = alarmWindowEnd
        self.nextRollover = nextRollover
        self.resumeTitle = resumeTitle
    }

    public var progress: Double { goalSeconds > 0 ? min(1, verifiedSeconds / Double(goalSeconds)) : 0 }

    /// The snapshot as it should look once the alarm window has closed without the app updating it:
    /// a racing day is now unknown, so it is marked missed only if we know the alarm fired.
    public func afterAlarmWindow() -> WidgetSnapshot {
        var s = self
        if s.status == .racing { s.status = .missed }
        return s
    }

    /// Best estimate of the snapshot right after rollover, used only until the widget or app refetches `/home`.
    /// The server's streak excludes the open day, so closing it adds one for a feast; a day that ended
    /// unfinished or missed resets the streak and adds a missed meal.
    public func rolledOver(nextRolloverAfter: Date) -> WidgetSnapshot {
        var s = self
        switch status {
        case .safe:
            s.streak = streak + 1
        case .missed, .racing:
            s.streak = 0
            s.activeMissedMeals = activeMissedMeals + 1
            s.famine = s.activeMissedMeals >= famineThreshold
        case .notStarted:
            break
        }
        s.status = .racing
        s.verifiedSeconds = 0
        s.goalSeconds = nextGoalSeconds
        s.alarmFiredAt = nil
        s.alarmWindowEnd = alarmWindowEnd.addingTimeInterval(24 * 3600)
        s.nextRollover = nextRolloverAfter
        return s
    }

    public static let placeholder = WidgetSnapshot(
        generatedAt: Date(), dayKey: "2026-10-12", status: .racing, verifiedSeconds: 150, goalSeconds: 300,
        nextGoalSeconds: 300, streak: 12, activeMissedMeals: 1, famine: false, famineThreshold: 3,
        alarmFiredAt: nil, alarmWindowEnd: Date().addingTimeInterval(6 * 3600),
        nextRollover: Date().addingTimeInterval(12 * 3600), resumeTitle: "Alma 32"
    )
}

/// Reads and writes the widget snapshot in the App Group's shared defaults.
public struct SnapshotStore: Sendable {
    public static let key = "widgetSnapshot.v1"
    private let suiteName: String

    public init(suiteName: String = AppGroup.identifier) {
        self.suiteName = suiteName
    }

    public func save(_ snapshot: WidgetSnapshot) {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let data = try? FeastJSON.encoder().encode(snapshot) else { return }
        defaults.set(data, forKey: Self.key)
    }

    public func load() -> WidgetSnapshot? {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let data = defaults.data(forKey: Self.key) else { return nil }
        return try? FeastJSON.decoder().decode(WidgetSnapshot.self, from: data)
    }

    public func clear() {
        UserDefaults(suiteName: suiteName)?.removeObject(forKey: Self.key)
    }
}
