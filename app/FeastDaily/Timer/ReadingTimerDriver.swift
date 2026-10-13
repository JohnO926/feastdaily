import Foundation
import Observation
import FeastCore

/// Connects the reader UI to the pure timer state machine and persists what it verifies.
///
/// One machine lives for the whole reader visit. Its verified total is cut into slices (rows) at split points:
/// every minute, the moment the goal is crossed, at rollover, at the alarm (when known), at the first scored day,
/// and when the app goes inactive. Each slice records only the verified time added since the previous cut, so
/// nothing is lost or counted twice across splits.
@MainActor
@Observable
final class ReadingTimerDriver {
    private(set) var machine: ReadingTimerMachine
    private(set) var showPrompt = false
    private(set) var displayedSeconds: Double = 0

    private let model: AppModel
    private let clock = SystemMonotonicClock()
    private var slice: PendingSession?
    private var sliceBase: Double = 0
    private var sliceStartedAt: Double = 0
    private var contentRef: String?
    private var ticker: Timer?
    private var goalCrossed = false
    private var isVisible = false

    static let sliceLength: Double = 60

    init(model: AppModel, initialPageChars: Int) {
        self.model = model
        machine = ReadingTimerMachine(initialPageChars: initialPageChars)
    }

    var verifiedSeconds: Double { machine.verifiedSeconds }

    // MARK: Inputs from the reader

    func readerAppeared(contentRef: String?) {
        self.contentRef = contentRef
        isVisible = true
        activate()
    }

    func readerDisappeared() {
        isVisible = false
        deactivate()
    }

    func scenePhaseChanged(active: Bool) {
        guard isVisible else { return }
        active ? activate() : deactivate()
    }

    func chapterChanged(contentRef: String?, pageChars: Int) {
        cutSlice()
        self.contentRef = contentRef
        handle(.pageShown(at: clock.now(), chars: pageChars))
    }

    func pageShown(chars: Int) { handle(.pageShown(at: clock.now(), chars: chars)) }

    func interaction() { handle(.interaction(at: clock.now())) }

    func answerPrompt(stillReading: Bool) {
        handle(.promptAnswered(at: clock.now(), stillReading: stillReading))
        if !stillReading { cutSlice() }
    }

    // MARK: Internals

    private func activate() {
        guard machine.phase == .inactive else { return }
        handle(.becameActive(at: clock.now()))
        startSlice()
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func deactivate() {
        ticker?.invalidate()
        ticker = nil
        handle(.becameInactive(at: clock.now()))
        closeSlice()
        Task { await model.syncSessions(); await model.afterStateChange() }
    }

    private func tick() {
        handle(.tick(at: clock.now()))
        guard let slice else { return }
        model.checkpoint(slice, activeSeconds: machine.verifiedSeconds - sliceBase)

        let elapsed = clock.now() - sliceStartedAt
        let total = model.display.verifiedSeconds
        if !goalCrossed && total >= Double(model.goalSeconds) {
            goalCrossed = true
            cutSlice(sync: true)
        } else if elapsed >= Self.sliceLength || crossedSplitInstant() {
            cutSlice(sync: true)
        }
    }

    /// True right after the rollover, the alarm, or the first scored day passes during this slice.
    private func crossedSplitInstant() -> Bool {
        guard let slice else { return false }
        let now = model.now
        let start = slice.estimatedServerEnd.addingTimeInterval(-(clock.now() - sliceStartedAt))
        var instants: [Date] = []
        if let end = model.home?.today?.windowEnd { instants.append(end) }
        if let alarm = model.home?.today?.alarmAt { instants.append(alarm) }
        if let first = model.home?.firstDayStartsAt { instants.append(first) }
        if let revealed = model.notifications.knownAlarmInstant { instants.append(revealed) }
        return instants.contains { $0 > start && $0 <= now }
    }

    private func handle(_ event: ReadingTimerEvent) {
        let effects = machine.apply(event)
        for e in effects {
            switch e {
            case .showStillReadingPrompt: showPrompt = true
            case .hidePrompt: showPrompt = false
            }
        }
        displayedSeconds = machine.verifiedSeconds
    }

    private func startSlice() {
        sliceBase = machine.verifiedSeconds
        sliceStartedAt = clock.now()
        slice = model.openSlice(source: .reader, contentRef: contentRef)
    }

    private func closeSlice() {
        guard let slice else { return }
        model.close(slice, activeSeconds: machine.verifiedSeconds - sliceBase)
        self.slice = nil
    }

    private func cutSlice(sync: Bool = false) {
        guard slice != nil else { return }
        closeSlice()
        if machine.phase != .inactive { startSlice() }
        if sync {
            Task {
                await model.syncSessions()
                await model.afterStateChange()
            }
        }
    }
}
