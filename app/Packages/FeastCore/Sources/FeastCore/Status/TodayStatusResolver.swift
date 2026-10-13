import Foundation

/// A local reading session not yet confirmed by the server.
public struct LocalSessionSummary: Sendable, Equatable {
    public var source: SessionSource
    public var activeSeconds: Double
    /// Best estimate of when the session ended, on the server's clock.
    public var endedAt: Date

    public init(source: SessionSource, activeSeconds: Double, endedAt: Date) {
        self.source = source
        self.activeSeconds = activeSeconds
        self.endedAt = endedAt
    }
}

/// What Home and the widget show for today.
public struct TodayDisplay: Sendable, Equatable {
    public var status: DayStatus
    public var verifiedSeconds: Double
    public var goalSeconds: Int
    public var alarmAt: Date?
    public var hasUnsynced: Bool

    public init(status: DayStatus, verifiedSeconds: Double, goalSeconds: Int, alarmAt: Date?, hasUnsynced: Bool) {
        self.status = status
        self.verifiedSeconds = verifiedSeconds
        self.goalSeconds = goalSeconds
        self.alarmAt = alarmAt
        self.hasUnsynced = hasUnsynced
    }

    public var progress: Double {
        goalSeconds > 0 ? min(1, verifiedSeconds / Double(goalSeconds)) : 0
    }
}

/// Merges the server's view of today with sessions that haven't synced yet.
///
/// Only unsynced sessions are added, so nothing is counted twice. Once the alarm has fired, only local time that
/// ended before the alarm can make the day safe; reading after it still shows in the progress ring.
public enum TodayStatusResolver {
    public static func resolve(
        home: HomeStateDTO?,
        unsynced: [LocalSessionSummary],
        fallbackGoalSeconds: Int,
        fallbackDay: DayModel,
        now: Date
    ) -> TodayDisplay {
        let localTotal = unsynced.filter { $0.source != .selfReport }.reduce(0) { $0 + $1.activeSeconds }

        guard let home else {
            let selfReported = unsynced.contains { $0.source == .selfReport }
            let safe = selfReported || localTotal >= Double(fallbackGoalSeconds)
            return TodayDisplay(status: safe ? .safe : .racing, verifiedSeconds: localTotal,
                                goalSeconds: fallbackGoalSeconds, alarmAt: nil, hasUnsynced: !unsynced.isEmpty)
        }

        if let first = home.firstDayStartsAt, now < first {
            return TodayDisplay(status: .notStarted, verifiedSeconds: localTotal,
                                goalSeconds: home.settings?.goalSeconds ?? fallbackGoalSeconds,
                                alarmAt: nil, hasUnsynced: !unsynced.isEmpty)
        }

        guard let today = home.today else {
            return TodayDisplay(status: .racing, verifiedSeconds: localTotal,
                                goalSeconds: home.settings?.goalSeconds ?? fallbackGoalSeconds,
                                alarmAt: nil, hasUnsynced: !unsynced.isEmpty)
        }

        // The cached day has ended: show a fresh day with only the local reading done since it ended.
        if now >= today.windowEnd {
            let goal = home.settings?.pendingGoalSeconds ?? home.settings?.goalSeconds ?? today.goalSeconds
            let fresh = unsynced.filter { $0.endedAt >= today.windowEnd }
            let freshTotal = fresh.filter { $0.source != .selfReport }.reduce(0) { $0 + $1.activeSeconds }
            let safe = fresh.contains { $0.source == .selfReport } || freshTotal >= Double(goal)
            return TodayDisplay(status: safe ? .safe : .racing, verifiedSeconds: freshTotal,
                                goalSeconds: goal, alarmAt: nil, hasUnsynced: !fresh.isEmpty)
        }

        let current = unsynced.filter { $0.endedAt >= today.windowStart }
        let currentTotal = current.filter { $0.source != .selfReport }.reduce(0) { $0 + $1.activeSeconds }
        let total = Double(today.verifiedSeconds) + currentTotal
        let alarmAt = today.alarmAt.flatMap { $0 <= now ? $0 : nil }

        let status: DayStatus
        if today.status == .safe {
            status = .safe
        } else if let alarmAt {
            let serverBefore = Double(today.verifiedBeforeAlarmSeconds ?? today.verifiedSeconds)
            let localBefore = current
                .filter { $0.source != .selfReport && $0.endedAt <= alarmAt }
                .reduce(0) { $0 + $1.activeSeconds }
            let selfReportBefore = current.contains { $0.source == .selfReport && $0.endedAt <= alarmAt }
            status = (selfReportBefore || serverBefore + localBefore >= Double(today.goalSeconds)) ? .safe : .missed
        } else {
            let selfReported = current.contains { $0.source == .selfReport }
            status = (selfReported || total >= Double(today.goalSeconds)) ? .safe : .racing
        }

        return TodayDisplay(status: status, verifiedSeconds: total, goalSeconds: today.goalSeconds,
                            alarmAt: alarmAt, hasUnsynced: !current.isEmpty)
    }
}
