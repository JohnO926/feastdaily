import Foundation

extension WidgetSnapshot {
    /// Builds a snapshot from a fresh `/home` response, keeping what only the app knows (unsynced local reading
    /// that already made today safe, and the resume title) from the previous snapshot for the same day.
    public static func from(home: HomeStateDTO, previous: WidgetSnapshot?, now: Date) -> WidgetSnapshot {
        let tz = home.settings.flatMap { TimeZone(identifier: $0.tz) } ?? .current
        let day = DayModel(rolloverHour: home.settings?.rolloverHour ?? 3, timeZone: tz)
        let display = TodayStatusResolver.resolve(home: home, unsynced: [], fallbackGoalSeconds: home.settings?.goalSeconds ?? 300,
                                                  fallbackDay: day, now: now)
        let window = home.config.window
        let dayKey = home.today?.dayKey.description ?? day.dayKey(for: now).description
        var status = display.status
        var verified = display.verifiedSeconds
        if let previous, previous.dayKey == dayKey, previous.status == .safe, status == .racing {
            status = .safe
            verified = max(verified, previous.verifiedSeconds)
        }
        let rollover = home.today.map { $0.windowEnd > now ? $0.windowEnd : day.nextRollover(after: now) }
            ?? day.nextRollover(after: now)
        return WidgetSnapshot(
            generatedAt: now, dayKey: dayKey, status: status, verifiedSeconds: verified,
            goalSeconds: display.goalSeconds,
            nextGoalSeconds: home.settings?.pendingGoalSeconds ?? home.settings?.goalSeconds ?? display.goalSeconds,
            streak: home.stats.currentStreak, activeMissedMeals: home.stats.activeMissedMeals,
            famine: home.stats.famine, famineThreshold: home.config.famineThreshold,
            alarmFiredAt: display.alarmAt, alarmWindowEnd: window.interval(on: window.alarmDate(for: now)).end,
            nextRollover: rollover, resumeTitle: previous?.resumeTitle
        )
    }

    /// Timeline entries from now until the next rollover: the current state, the state once the alarm window has
    /// closed (a day still racing then must have missed), and the fresh day after rollover.
    public func timeline(now: Date) -> [(date: Date, snapshot: WidgetSnapshot)] {
        var entries: [(Date, WidgetSnapshot)] = [(now, self)]
        if status == .racing, alarmWindowEnd > now, alarmWindowEnd < nextRollover {
            entries.append((alarmWindowEnd, afterAlarmWindow()))
        }
        if nextRollover > now {
            let last = entries.last!.1
            entries.append((nextRollover, last.rolledOver(nextRolloverAfter: nextRollover.addingTimeInterval(24 * 3600))))
        }
        return entries
    }
}

/// Minimal `/home` fetch for the widget extension, which can't use the app's API client.
public enum WidgetHomeFetcher {
    public static func fetch(baseURL: URL, token: String, timeout: TimeInterval = 3) async -> HomeStateDTO? {
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/v1/home"), timeoutInterval: timeout)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? FeastJSON.decoder().decode(HomeStateDTO.self, from: data)
    }
}
