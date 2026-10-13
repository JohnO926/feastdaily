import Foundation
import WidgetKit
import FeastCore

/// Writes today's state into the App Group for the widget and asks WidgetKit to reload.
@MainActor
struct SnapshotPublisher {
    let store = SnapshotStore()

    func publish(model: AppModel) {
        let home = model.home
        let display = model.display
        let window = home?.config.window ?? .standard
        let now = model.now
        let nextRollover = home?.today?.windowEnd.flatMapIfFuture(now) ?? model.dayModel.nextRollover(after: now)
        let snapshot = WidgetSnapshot(
            generatedAt: now,
            dayKey: home?.today?.dayKey.description ?? model.dayModel.dayKey(for: now).description,
            status: display.status,
            verifiedSeconds: display.verifiedSeconds,
            goalSeconds: display.goalSeconds,
            nextGoalSeconds: home?.settings?.pendingGoalSeconds ?? home?.settings?.goalSeconds ?? display.goalSeconds,
            streak: home?.stats.currentStreak ?? 0,
            activeMissedMeals: home?.stats.activeMissedMeals ?? 0,
            famine: home?.stats.famine ?? false,
            famineThreshold: home?.config.famineThreshold ?? 3,
            alarmFiredAt: display.alarmAt,
            alarmWindowEnd: window.interval(on: window.alarmDate(for: now)).end,
            nextRollover: nextRollover,
            resumeTitle: model.resumeTitle
        )
        store.save(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
    }

    func clear() {
        store.clear()
        WidgetCenter.shared.reloadAllTimelines()
    }
}

private extension Date {
    func flatMapIfFuture(_ now: Date) -> Date? { self > now ? self : nil }
}
