import Foundation
import UserNotifications
import FeastCore

/// The parts of `UNUserNotificationCenter` the planner uses, so tests can substitute a fake.
protocol NotificationCenterProtocol: Sendable {
    func pendingIdentifiers() async -> [String: Date]
    func add(_ request: UNNotificationRequest) async throws
    func remove(_ identifiers: [String])
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
}

struct SystemNotificationCenter: NotificationCenterProtocol {
    func pendingIdentifiers() async -> [String: Date] {
        let requests = await UNUserNotificationCenter.current().pendingNotificationRequests()
        var out: [String: Date] = [:]
        for r in requests {
            if let t = r.trigger as? UNCalendarNotificationTrigger, let d = t.nextTriggerDate() { out[r.identifier] = d }
        }
        return out
    }
    func add(_ request: UNNotificationRequest) async throws { try await UNUserNotificationCenter.current().add(request) }
    func remove(_ identifiers: [String]) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: identifiers)
    }
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: options)
    }
}

/// A notification the planner wants scheduled.
struct PlannedNotification: Equatable {
    enum Kind: String { case alarm, safe, reminder }
    let id: String
    let kind: Kind
    let fireAt: Date
    let title: String
    let body: String
    let alarmDate: String?
}

/// Keeps the local notifications in line with today's state. Idempotent; call it after anything changes.
///
/// - `alarm-<alarm_date>`: the simulated daily alarm (local simulation mode only; with push the server sends it).
///   The quiet "You're safe today" variant replaces it once today is safe.
/// - `reminder-<day_key>`: the optional morning reminder, skipped for a day that's already safe.
@MainActor
final class NotificationPlanner {
    private let center: NotificationCenterProtocol
    private let source: AlarmSource
    /// The alarm instant for today, when known (dev reveal). Used to split reading sessions at the alarm.
    private(set) var knownAlarmInstant: Date?

    init(center: NotificationCenterProtocol = SystemNotificationCenter(), source: AlarmSource? = nil) {
        self.center = center
        self.source = source ?? AlarmSource()
    }

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge, .timeSensitive])
    }

    func removeAll() async {
        let pending = await center.pendingIdentifiers()
        center.remove(Array(pending.keys))
    }

    func reconcile(model: AppModel) async {
        let desired = await plan(model: model)
        await apply(desired)
    }

    func plan(model: AppModel) async -> [PlannedNotification] {
        let now = model.now
        let window = model.home?.config.window ?? .standard
        var out: [PlannedNotification] = []

        if BuildConfig.alarmMode == .localSimulation {
            let today = window.alarmDate(for: now)
            for offset in 0..<3 {
                let date = today.adding(days: offset)
                guard let instant = await source.instant(for: date, window: window, api: model.api) else { continue }
                if offset == 0 { knownAlarmInstant = source.isRevealed(date) ? instant : nil }
                guard instant > now else { continue }
                if let first = model.home?.firstDayStartsAt, instant < first { continue }
                let safe = offset == 0 && model.display.status == .safe
                out.append(Self.alarmNotification(date: date.description, at: instant, safe: safe))
            }
        }

        if let settings = model.home?.settings, settings.reminderEnabled,
           let hm = AppModel.parseHM(settings.reminderLocalTime) {
            let day = model.dayModel
            var key = day.dayKey(for: now)
            for _ in 0..<7 {
                let fireAt = key.date(hour: hm.hour ?? 6, minute: hm.minute ?? 0, in: day.timeZone)
                let isToday = key == day.dayKey(for: now)
                if fireAt > now && !(isToday && model.display.status == .safe) {
                    out.append(PlannedNotification(
                        id: "reminder-\(key)", kind: .reminder, fireAt: fireAt,
                        title: "Feast before the alarm",
                        body: "Read for \(ScoringDisplay.goalLabel(seconds: model.goalSeconds)) and you're safe today.",
                        alarmDate: nil))
                }
                key = key.adding(days: 1)
            }
        }
        return out
    }

    static func alarmNotification(date: String, at instant: Date, safe: Bool) -> PlannedNotification {
        safe
            ? PlannedNotification(id: "alarm-\(date)", kind: .safe, fireAt: instant, title: "You're safe today",
                                  body: "The alarm just went off. You'd already feasted.", alarmDate: date)
            : PlannedNotification(id: "alarm-\(date)", kind: .alarm, fireAt: instant, title: "The alarm went off",
                                  body: "Today is a missed meal. Reading still counts toward your history.",
                                  alarmDate: date)
    }

    /// Removes what is no longer wanted and (re)adds what changed. A notification can't be edited in place.
    func apply(_ desired: [PlannedNotification]) async {
        let pending = await center.pendingIdentifiers()
        let managed = pending.keys.filter { $0.hasPrefix("alarm-") || $0.hasPrefix("reminder-") }
        let desiredIds = Set(desired.map(\.id))
        center.remove(managed.filter { !desiredIds.contains($0) })

        for n in desired {
            if let existing = pending[n.id], abs(existing.timeIntervalSince(n.fireAt)) < 1,
               lastKinds[n.id] == n.kind { continue }
            center.remove([n.id])
            let content = UNMutableNotificationContent()
            content.title = n.title
            content.body = n.body
            content.userInfo = ["kind": n.kind.rawValue, "alarm_date": n.alarmDate ?? ""]
            switch n.kind {
            case .alarm:
                content.sound = .default
                content.interruptionLevel = .timeSensitive
            case .safe:
                content.interruptionLevel = .active
            case .reminder:
                content.sound = .default
                content.interruptionLevel = .active
            }
            let comps = Calendar.gregorian(in: .current)
                .dateComponents(in: .current, from: n.fireAt)
            let trigger = UNCalendarNotificationTrigger(
                dateMatching: DateComponents(timeZone: comps.timeZone, year: comps.year, month: comps.month,
                                             day: comps.day, hour: comps.hour, minute: comps.minute,
                                             second: comps.second),
                repeats: false)
            try? await center.add(UNNotificationRequest(identifier: n.id, content: content, trigger: trigger))
            lastKinds[n.id] = n.kind
        }
    }

    private var lastKinds: [String: PlannedNotification.Kind] = [:]
}

/// Where the simulated alarm time comes from on the free tier.
///
/// In development the server reveals the real secret time (`DEV_REVEAL_ALARM=true`), so the local notification
/// fires at the instant the server scores against. Otherwise a deterministic random time per date is used, so
/// reconciling repeatedly doesn't move it.
@MainActor
final class AlarmSource {
    private var revealed: [String: Date] = [:]
    private var lastFetch: Date?

    func isRevealed(_ date: DayKey) -> Bool { revealed[date.description] != nil }

    func instant(for date: DayKey, window: AlarmWindow, api: APIClient) async -> Date? {
        if let r = revealed[date.description] { return r }
        if date == window.alarmDate(for: Date()), lastFetch.map({ Date().timeIntervalSince($0) > 300 }) ?? true {
            lastFetch = Date()
            if let dev = try? await api.devTodayAlarm(), dev.alarmDate == date {
                revealed[date.description] = dev.fireAt
                return dev.fireAt
            }
        }
        var rng = DateSeededGenerator(seed: date.description)
        return window.randomInstant(on: date, using: &rng)
    }
}

/// Deterministic generator seeded from a string (FNV-1a + SplitMix64).
struct DateSeededGenerator: RandomNumberGenerator {
    var state: UInt64
    init(seed: String) {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in seed.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 }
        state = h
    }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
