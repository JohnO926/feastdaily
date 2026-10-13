import Foundation
import Observation
import SwiftData
import FeastCore
import FeastScripture

/// App-wide state and the orchestration between server, local store, notifications and widget.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case launching, onboarding, ready }

    // Dependencies
    let container: ModelContainer
    var context: ModelContext { container.mainContext }
    let api: APIClient
    let auth: DeviceAuth
    let scripture: ScriptureDatabase?
    let notifications: NotificationPlanner
    let snapshots: SnapshotPublisher
    let analytics: Analytics
    let mono = SystemMonotonicClock()
    let bootId = BootSession.identifier()
    private(set) var serverClock = ServerClock()

    // State
    private(set) var phase: Phase = .launching
    private(set) var home: HomeStateDTO?
    private(set) var display: TodayDisplay
    private(set) var lastError: String?
    private(set) var isSyncing = false
    var alarmMoment: AlarmDTO?
    let router = AppRouter.shared

    init(container: ModelContainer = Persistence.makeContainer(inMemory: BuildConfig.isUITesting)) {
        self.container = container
        let keychain = Keychain()
        api = APIClient(keychain: keychain)
        auth = DeviceAuth(keychain: keychain)
        scripture = try? ScriptureDatabase(bundle: .main)
        notifications = NotificationPlanner()
        snapshots = SnapshotPublisher()
        analytics = Analytics(appID: BuildConfig.telemetryDeckAppID)
        display = TodayDisplay(status: .racing, verifiedSeconds: 0, goalSeconds: 300, alarmAt: nil, hasUnsynced: false)
        loadCachedHome()
        recompute()
    }

    // MARK: Local settings

    var localSettings: LocalSettings {
        if let s = try? context.fetch(FetchDescriptor<LocalSettings>()).first { return s }
        let s = LocalSettings()
        context.insert(s)
        try? context.save()
        return s
    }

    var readingPosition: ReadingPosition? {
        try? context.fetch(FetchDescriptor<ReadingPosition>()).first
    }

    func savePosition(chapterId: Int, pageIndex: Int, verseNumber: Int) {
        if let p = readingPosition {
            p.chapterId = chapterId
            p.pageIndex = pageIndex
            p.verseNumber = verseNumber
            p.updatedAt = Date()
        } else {
            context.insert(ReadingPosition(chapterId: chapterId, pageIndex: pageIndex, verseNumber: verseNumber))
        }
        try? context.save()
    }

    /// Where "Continue reading" goes: the saved position, else the start of the Book of Mormon.
    var resumeChapterId: Int? {
        if let id = readingPosition?.chapterId { return id }
        return (try? scripture?.firstChapterId(inVolume: "book-of-mormon")) ?? (try? scripture?.firstChapterId()) ?? nil
    }

    var resumeTitle: String? {
        guard let id = resumeChapterId else { return nil }
        return (try? scripture?.location(chapterId: id))??.title
    }

    var now: Date { serverClock.now(currentBoot: bootId) }

    var dayModel: DayModel {
        let tz = home?.settings.flatMap { TimeZone(identifier: $0.tz) } ?? .current
        return DayModel(rolloverHour: home?.settings?.rolloverHour ?? 3, timeZone: tz)
    }

    var goalSeconds: Int { home?.today?.goalSeconds ?? home?.settings?.goalSeconds ?? 300 }

    // MARK: Lifecycle

    func start() async {
        closeOrphanedSessions()
        analytics.signal("app_open")
        if BuildConfig.isUITesting && BuildConfig.isOfflineTesting {
            if ProcessInfo.processInfo.arguments.contains("-skipOnboarding") {
                localSettings.onboarded = true
                phase = .ready
                if ProcessInfo.processInfo.arguments.contains("-openReader") { router.pendingResume = true }
            } else {
                phase = .onboarding
            }
            return
        }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-resetIdentity") {
            auth.reset()
            await api.setToken(nil)
        }
        #endif
        await api.setReauthenticate { [auth, api] in try await auth.signIn(api: api) }
        do {
            if !(await api.hasToken) { _ = try await auth.signIn(api: api) }
            // Unsynced sessions must be the first request after reconnecting: any other request counts as
            // device contact, and sessions that ended before it would only count as history.
            await syncSessions()
            let h = try await api.home()
            apply(home: h)
            // A reinstall keeps the Keychain identity, so the server may already know this user.
            let onboarded = h.onboarded ?? (h.settings != nil)
            phase = onboarded || localSettings.onboarded ? .ready : .onboarding
            if onboarded { localSettings.onboarded = true }
            await afterStateChange()
        } catch {
            lastError = error.localizedDescription
            phase = localSettings.onboarded ? .ready : .onboarding
        }
    }

    func onForeground() async {
        guard phase == .ready else { return }
        await refresh()
        await syncTimeZoneIfNeeded()
        await afterStateChange()
    }

    /// Uploads pending sessions first (see `start()`), then fetches home.
    func refresh() async {
        guard !BuildConfig.isOfflineTesting else { return }
        await syncSessions()
        do {
            apply(home: try await api.home())
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: Onboarding and settings

    func completeOnboarding(goalSeconds: Int, rolloverHour: Int, reminder: DateComponents?) async {
        let request = OnboardingRequestDTO(
            tz: TimeZone.current.identifier, rolloverHour: rolloverHour, goalSeconds: goalSeconds,
            reminderEnabled: reminder != nil, reminderLocalTime: reminder.map(Self.formatHM)
        )
        if !BuildConfig.isOfflineTesting {
            do {
                apply(home: try await api.onboarding(request))
            } catch {
                lastError = error.localizedDescription
                return
            }
        }
        localSettings.onboarded = true
        localSettings.lastSentTimeZone = request.tz
        try? context.save()
        phase = .ready
        analytics.signal("onboarding_complete", ["goal_seconds": "\(goalSeconds)"])
        await notifications.requestAuthorization()
        await afterStateChange()
    }

    func updateSettings(_ patch: SettingsPatchDTO) async {
        await syncSessions()
        do {
            apply(home: try await api.patchSettings(patch))
            await afterStateChange()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func syncTimeZoneIfNeeded() async {
        let tz = TimeZone.current.identifier
        guard home?.settings != nil, localSettings.lastSentTimeZone != tz || home?.settings?.tz != tz else { return }
        await updateSettings(SettingsPatchDTO(tz: tz))
        localSettings.lastSentTimeZone = tz
        try? context.save()
    }

    func deleteAccount() async -> Bool {
        do {
            try await api.deleteAccount()
        } catch {
            lastError = error.localizedDescription
            return false
        }
        auth.reset()
        await api.setToken(nil)
        try? context.delete(model: PendingSession.self)
        try? context.delete(model: ReadingPosition.self)
        try? context.delete(model: HomeStateCache.self)
        try? context.delete(model: DailyResultCache.self)
        try? context.delete(model: LocalSettings.self)
        try? context.save()
        snapshots.clear()
        await notifications.removeAll()
        home = nil
        phase = .onboarding
        _ = try? await auth.signIn(api: api)
        return true
    }

    // MARK: Sessions

    /// Opens a new slice. The driver updates it every tick and closes it at the next split point.
    func openSlice(source: SessionSource, contentRef: String?) -> PendingSession {
        let s = PendingSession(source: source, bootId: bootId, startedAtWall: Date(),
                               monoStartMs: mono.nowMilliseconds(), contentRef: contentRef, estimatedServerEnd: now)
        context.insert(s)
        try? context.save()
        return s
    }

    func checkpoint(_ slice: PendingSession, activeSeconds: Double) {
        slice.activeSeconds = activeSeconds
        slice.monoEndMs = mono.nowMilliseconds()
        slice.endedAtWall = Date()
        slice.estimatedServerEnd = now
        try? context.save()
        recompute()
    }

    func close(_ slice: PendingSession, activeSeconds: Double) {
        checkpoint(slice, activeSeconds: activeSeconds)
        slice.isOpen = false
        if slice.activeSeconds < 1 && slice.source == .reader {
            context.delete(slice)
        }
        try? context.save()
        recompute()
    }

    /// Rows left open by a crash or OS kill are closed at their last checkpoint.
    private func closeOrphanedSessions() {
        let open = (try? context.fetch(FetchDescriptor<PendingSession>(predicate: #Predicate { $0.isOpen }))) ?? []
        for s in open {
            s.isOpen = false
            if s.activeSeconds < 1 && s.source == .reader { context.delete(s) }
        }
        try? context.save()
    }

    func selfReport() async {
        guard display.status == .racing else { return }
        let s = openSlice(source: .selfReport, contentRef: nil)
        s.isOpen = false
        try? context.save()
        recompute()
        analytics.signal("self_report")
        await syncSessions()
        await afterStateChange()
    }

    private var unsyncedSessions: [PendingSession] {
        let pending = PendingSession.SyncState.pending.rawValue
        let d = FetchDescriptor<PendingSession>(predicate: #Predicate { $0.syncStateRaw == pending })
        return (try? context.fetch(d)) ?? []
    }

    var hasSelfReportedToday: Bool {
        if home?.today?.selfReportedAt != nil { return true }
        let start = home?.today?.windowStart ?? dayModel.bounds(of: dayModel.dayKey(for: now)).lowerBound
        return unsyncedSessions.contains { $0.source == .selfReport && $0.estimatedServerEnd >= start }
    }

    func syncSessions() async {
        guard !BuildConfig.isOfflineTesting, !isSyncing else { return }
        // Only closed slices are sent; the driver closes one every minute while reading.
        let rows = unsyncedSessions.filter { !$0.isOpen }
        guard !rows.isEmpty else { return }
        isSyncing = true
        defer { isSyncing = false }
        let identity = auth.identity()
        let envelope = SessionEnvelopeDTO(
            deviceId: identity.deviceId, bootId: bootId, clientNowWall: Date(),
            clientNowMonoMs: mono.nowMilliseconds(), sessions: rows.prefix(200).map(\.upload)
        )
        do {
            let response = try await api.submitSessions(envelope)
            let byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            for r in response.results {
                guard let row = byId[r.id] else { continue }
                switch r.status {
                case .accepted, .duplicate:
                    row.syncState = .synced
                case .rejected:
                    row.syncState = .rejected
                    row.rejectReason = r.reason
                }
                row.serverDayKey = r.dayKey?.description
            }
            try? context.save()
            pruneSyncedSessions()
            apply(home: response.home)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Synced rows are only needed until the server's home state reflects them.
    private func pruneSyncedSessions() {
        let synced = PendingSession.SyncState.synced.rawValue
        let cutoff = Date().addingTimeInterval(-3 * 24 * 3600)
        let d = FetchDescriptor<PendingSession>(predicate: #Predicate { $0.syncStateRaw == synced && $0.endedAtWall < cutoff })
        for s in (try? context.fetch(d)) ?? [] { context.delete(s) }
        try? context.save()
    }

    // MARK: Alarm

    /// Called when the alarm notification arrives (local simulation or push).
    func alarmArrived(alarmDate: String?) async {
        analytics.signal("alarm_received", ["status": display.status.rawValue])
        await refresh()
        if let a = try? await api.alarmToday(), a.fired {
            alarmMoment = a
            markRevealed(a.alarmDate.description)
        } else if let alarmDate, let key = DayKey(alarmDate) {
            alarmMoment = AlarmDTO(alarmDate: key, fired: true, firedAt: now)
        }
        await afterStateChange()
    }

    private func markRevealed(_ date: String) {
        var dates = localSettings.revealedAlarmDates
        if !dates.contains(date) { dates.append(date) }
        localSettings.revealedAlarmDates = Array(dates.suffix(14))
        try? context.save()
    }

    /// Shows the shared moment once per alarm when the app opens after it fired, but only if that alarm
    /// decided one of this user's days (not, say, an alarm that fired before their first scored day).
    func revealAlarmIfNeeded() {
        guard let a = home?.alarm, a.fired, home?.today?.alarmAt != nil,
              !localSettings.revealedAlarmDates.contains(a.alarmDate.description) else {
            return
        }
        alarmMoment = a
        markRevealed(a.alarmDate.description)
    }

    // MARK: State

    private func apply(home h: HomeStateDTO) {
        home = h
        serverClock.anchor(serverNow: h.serverNow, monoSeconds: mono.now(), bootId: bootId)
        if let data = try? FeastJSON.encoder().encode(h) {
            let caches = (try? context.fetch(FetchDescriptor<HomeStateCache>())) ?? []
            caches.forEach { context.delete($0) }
            context.insert(HomeStateCache(json: data, fetchedAt: Date(), fetchedMonoSeconds: mono.now(), bootId: bootId))
            try? context.save()
        }
        recompute()
        revealAlarmIfNeeded()
        scheduleBoundaryRefresh()
    }

    private var boundaryTask: Task<Void, Never>?

    /// Refreshes right after the next instant that changes today's state (first scored day, rollover, the end
    /// of the alarm window, or the alarm itself when known), so Home doesn't sit on a stale status while open.
    private func scheduleBoundaryRefresh() {
        boundaryTask?.cancel()
        let now = self.now
        var instants: [Date] = []
        if let first = home?.firstDayStartsAt { instants.append(first) }
        if let end = home?.today?.windowEnd { instants.append(end) }
        if home?.alarm?.fired != true {
            let window = home?.config.window ?? .standard
            instants.append(window.interval(on: window.alarmDate(for: now)).end)
            if let known = notifications.knownAlarmInstant { instants.append(known) }
        }
        guard let next = instants.filter({ $0 > now }).min() else { return }
        let delay = min(next.timeIntervalSince(now) + 2, 6 * 3600)
        boundaryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.refresh()
            await self.afterStateChange()
        }
    }

    private func loadCachedHome() {
        guard let cache = try? context.fetch(FetchDescriptor<HomeStateCache>()).first,
              let h = try? FeastJSON.decoder().decode(HomeStateDTO.self, from: cache.json) else { return }
        home = h
        if cache.bootId == bootId {
            serverClock.anchor(serverNow: h.serverNow, monoSeconds: cache.fetchedMonoSeconds, bootId: bootId)
        }
    }

    func recompute() {
        let previous = display.status
        display = TodayStatusResolver.resolve(
            home: home, unsynced: unsyncedSessions.map(\.summary), fallbackGoalSeconds: goalSeconds,
            fallbackDay: dayModel, now: now
        )
        if previous != .safe && display.status == .safe {
            analytics.signal("goal_reached")
        }
    }

    /// Re-plans notifications and republishes the widget snapshot after anything that changes today's state.
    func afterStateChange() async {
        recompute()
        snapshots.publish(model: self)
        await notifications.reconcile(model: self)
    }

    static func formatHM(_ c: DateComponents) -> String {
        String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    static func parseHM(_ s: String?) -> DateComponents? {
        guard let s else { return nil }
        let p = s.split(separator: ":").compactMap { Int($0) }
        guard p.count >= 2 else { return nil }
        return DateComponents(hour: p[0], minute: p[1])
    }
}
