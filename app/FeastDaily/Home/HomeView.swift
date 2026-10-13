import SwiftUI
import FeastCore

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppRouter.self) private var router
    @State private var showHonesty = false

    var body: some View {
        @Bindable var router = router
        @Bindable var model = model
        NavigationStack(path: $router.path) {
            ScrollView {
                VStack(spacing: 20) {
                    statusSection
                    streakSection
                    alarmSection
                    actions
                    if let error = model.lastError { offlineNote(error) }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(Theme.parchment.ignoresSafeArea())
            .navigationTitle("Feast Daily")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink(value: Route.history) {
                        Image(systemName: "calendar").accessibilityLabel("History")
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink(value: Route.search) {
                        Image(systemName: "magnifyingglass").accessibilityLabel("Search")
                    }
                    NavigationLink(value: Route.settings) {
                        Image(systemName: "gearshape").accessibilityLabel("Settings")
                    }
                }
            }
            .navigationDestination(for: Route.self, destination: destination)
            .refreshable {
                await model.refresh()
                await model.afterStateChange()
            }
        }
        .tint(Theme.ink)
        .sheet(item: $model.alarmMoment) { AlarmMomentSheet(alarm: $0) }
        .sheet(isPresented: $showHonesty) { HonestySheet() }
        .onChange(of: router.pendingResume, initial: true) { _, pending in
            guard pending, let id = model.resumeChapterId else { return }
            router.pendingResume = false
            router.path = [.reader(chapterId: id)]
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .library: LibraryView()
        case .volume(let id): BookListView(volumeId: id)
        case .book(let id): ChapterGridView(bookId: id)
        case .reader(let chapterId): ReaderView(chapterId: chapterId)
        case .history: HistoryView()
        case .settings: SettingsView()
        case .search: SearchView()
        }
    }

    private var statusSection: some View {
        let d = model.display
        return VStack(spacing: 14) {
            ProgressRing(progress: d.progress, color: Theme.color(for: d.status)) {
                VStack(spacing: 4) {
                    Text(ScoringDisplay.durationLabel(seconds: d.verifiedSeconds))
                        .font(.system(size: 34, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(Theme.ink)
                    Text("of \(ScoringDisplay.goalLabel(seconds: d.goalSeconds))")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                }
            }
            .frame(width: 210, height: 210)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(ScoringDisplay.durationLabel(seconds: d.verifiedSeconds)) read of \(ScoringDisplay.goalLabel(seconds: d.goalSeconds))")

            Text(ScoringDisplay.statusTitle(d.status))
                .font(Theme.title(26))
                .foregroundStyle(Theme.color(for: d.status))
            Text(statusDetail)
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.muted)
            if d.hasUnsynced {
                Label("Not yet synced", systemImage: "icloud.slash")
                    .font(.caption).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    private var statusDetail: String {
        let d = model.display
        switch d.status {
        case .notStarted:
            if let first = model.home?.firstDayStartsAt {
                return "Scoring starts \(first.formatted(date: .abbreviated, time: .shortened)). Reading now still counts toward your history."
            }
            return "Scoring starts at your next rollover."
        case .racing:
            return "The alarm can go off any moment between 10:00 AM and 8:30 PM Mountain Time. Finish before it does."
        case .safe:
            return d.alarmAt == nil ? "You've feasted. When the alarm goes off, you'll get a quiet note instead." : "You beat the alarm today."
        case .missed:
            return "The alarm beat you today. Reading still counts toward your history and plans."
        }
    }

    private var streakSection: some View {
        let stats = model.home?.stats ?? StatsDTO()
        let threshold = model.home?.config.famineThreshold ?? 3
        let marks = ScoringDisplay.marks(activeMissedMeals: stats.activeMissedMeals, famineThreshold: threshold)
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Feast streak").font(.caption).foregroundStyle(Theme.muted)
                Text("\(stats.currentStreak)")
                    .font(.system(size: 30, weight: .semibold, design: .serif)).foregroundStyle(Theme.ink)
                Text("Longest \(stats.longestStreak) · \(stats.totalFeasts) feasts").font(.caption2).foregroundStyle(Theme.muted)
            }
            .card()
            VStack(alignment: .leading, spacing: 4) {
                Text("Missed meals").font(.caption).foregroundStyle(Theme.muted)
                HStack(spacing: 6) {
                    ForEach(0..<threshold, id: \.self) { i in
                        Image(systemName: i < marks ? "fork.knife.circle.fill" : "circle")
                            .font(.title2)
                            .foregroundStyle(i < marks ? Theme.missed : Theme.muted.opacity(0.35))
                    }
                }
                .frame(height: 36)
                Text(stats.famine ? "Famine. Back under \(threshold) to climb again." : restoreLine(stats))
                    .font(.caption2).foregroundStyle(stats.famine ? Theme.missed : Theme.muted)
            }
            .card()
        }
        .accessibilityElement(children: .combine)
    }

    private func restoreLine(_ s: StatsDTO) -> String {
        let need = model.home?.config.feastsToRestore ?? 4
        guard s.activeMissedMeals > 0 else { return "None. Keep it that way." }
        return "\(max(0, need - s.restoreProgress)) more feasts in a row restores one"
    }

    @ViewBuilder
    private var alarmSection: some View {
        if let alarm = model.home?.alarm, alarm.fired, let firedAt = alarm.firedAt {
            VStack(alignment: .leading, spacing: 6) {
                Label("Today's alarm", systemImage: "alarm").font(.caption).foregroundStyle(Theme.muted)
                Text(firedAt.formatted(date: .omitted, time: .shortened))
                    .font(Theme.title(24)).foregroundStyle(Theme.ink)
                if let pct = alarm.beatPct {
                    Text("\(Int(pct.rounded()))% of readers beat it").font(.callout).foregroundStyle(Theme.muted)
                }
            }
            .card()
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Label("Today's alarm", systemImage: "alarm").font(.caption).foregroundStyle(Theme.muted)
                Text("Hidden until it goes off").font(.headline).foregroundStyle(Theme.ink)
                Text("Same moment for every reader, wherever they live.").font(.caption).foregroundStyle(Theme.muted)
            }
            .card()
        }
    }

    private var actions: some View {
        VStack(spacing: 10) {
            if let id = model.resumeChapterId {
                NavigationLink(value: Route.reader(chapterId: id)) {
                    Label(model.resumeTitle.map { "Continue \($0)" } ?? "Start reading", systemImage: "book")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .foregroundStyle(Theme.parchment)
                        .background(Theme.ink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .accessibilityIdentifier("continueReading")
            }
            NavigationLink(value: Route.library) {
                Text("Browse the standard works").font(.subheadline).frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            if model.display.status == .racing && !model.hasSelfReportedToday {
                Button("I read somewhere else today") { showHonesty = true }
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("selfReport")
            }
        }
    }

    private func offlineNote(_ error: String) -> some View {
        Label("Offline. Your reading is saved and will sync.", systemImage: "wifi.slash")
            .font(.caption)
            .foregroundStyle(Theme.muted)
            .help(error)
    }
}
