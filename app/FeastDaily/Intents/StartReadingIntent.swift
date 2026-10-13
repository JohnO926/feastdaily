import AppIntents

/// "Hey Siri, start my reading": opens the reader where you left off.
struct StartReadingIntent: AppIntent {
    static let title: LocalizedStringResource = "Start my reading"
    static let description = IntentDescription("Opens Feast Daily to the chapter you were reading.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.pendingResume = true
        return .result()
    }
}

struct FeastDailyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartReadingIntent(),
            phrases: ["Start my reading in \(.applicationName)", "Feast in \(.applicationName)"],
            shortTitle: "Start reading",
            systemImageName: "book"
        )
    }
}
