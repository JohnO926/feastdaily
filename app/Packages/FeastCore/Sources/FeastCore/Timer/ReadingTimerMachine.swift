import Foundation

/// Tuning for the anti-cheat pace rules.
public struct PaceRule: Sendable, Equatable {
    /// Page turns faster than this per full screen of text don't accrue time.
    public var minSecondsPerScreen: Double = 3.0
    /// What counts as a full screen of text.
    public var charsPerScreen: Int = 1_200
    /// Typical reading speed, used to cap how long one page can earn credit.
    public var charsPerSecond: Double = 20
    /// A page earns at most this multiple of its expected reading time...
    public var maxDwellMultiplier: Double = 4
    /// ...but never less than this many seconds.
    public var maxDwellFloor: Double = 60
    /// Without an interaction for this long, accrual stops and the "still reading?" prompt shows.
    public var idleTimeout: Double = 60

    public init() {}

    public func minDwell(chars: Int) -> Double {
        minSecondsPerScreen * min(1, Double(max(chars, 0)) / Double(charsPerScreen))
    }

    public func maxDwell(chars: Int) -> Double {
        max(maxDwellFloor, maxDwellMultiplier * Double(max(chars, 0)) / charsPerSecond)
    }
}

public enum ReadingTimerEvent: Sendable, Equatable {
    /// Reader is visible, the app is active and the screen is on.
    case becameActive(at: Double)
    /// App went inactive or background, screen locked, or the reader was dismissed.
    case becameInactive(at: Double)
    /// Tap, scroll, or settings change.
    case interaction(at: Double)
    /// A new page (or a new viewport of text in scroll mode) became visible. Counts as an interaction.
    case pageShown(at: Double, chars: Int)
    case promptAnswered(at: Double, stillReading: Bool)
    /// Periodic tick from the driver while the reader is open.
    case tick(at: Double)

    var time: Double {
        switch self {
        case .becameActive(let t), .becameInactive(let t), .interaction(let t), .tick(let t): t
        case .pageShown(let t, _): t
        case .promptAnswered(let t, _): t
        }
    }
}

public enum TimerEffect: Sendable, Equatable {
    case showStillReadingPrompt
    case hidePrompt
}

/// Pure state machine for verified reading time. All inputs carry monotonic timestamps in seconds.
///
/// Rules (from the requirements' verification section):
/// - Time accrues only while the reader is active and visible.
/// - Without interaction for `idleTimeout`, accrual stops at `lastInteraction + idleTimeout` and the prompt shows.
/// - A page shown for less than `minDwell(chars)` earns nothing; a page earns at most `maxDwell(chars)`.
/// - Events with decreasing timestamps are ignored. `verifiedSeconds` never decreases.
public struct ReadingTimerMachine: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case inactive, reading, idlePrompt }

    public let pace: PaceRule
    public private(set) var phase: Phase = .inactive
    public private(set) var committedSeconds: Double = 0

    private var pageChars: Int = 0
    private var pageAccrued: Double = 0
    private var lastMark: Double = 0
    private var lastInteractionAt: Double = 0
    private var lastEventAt: Double = -.infinity

    public init(pace: PaceRule = PaceRule(), initialPageChars: Int = 0) {
        self.pace = pace
        self.pageChars = initialPageChars
    }

    /// Verified seconds as of the last applied event.
    public var verifiedSeconds: Double { committedSeconds + inProgressCredit(pageAccrued) }

    /// Verified seconds if accrual continued until `now` with no further events. Does not mutate.
    public func verifiedSeconds(at now: Double) -> Double {
        guard phase == .reading, now >= lastEventAt else { return verifiedSeconds }
        let limit = min(now, lastInteractionAt + pace.idleTimeout)
        let extra = max(0, limit - lastMark)
        return committedSeconds + inProgressCredit(pageAccrued + extra)
    }

    @discardableResult
    public mutating func apply(_ event: ReadingTimerEvent) -> [TimerEffect] {
        let t = event.time
        guard t >= lastEventAt else { return [] }
        lastEventAt = t

        var effects: [TimerEffect] = []
        if phase == .reading, t - lastInteractionAt >= pace.idleTimeout {
            accrue(to: t)
            phase = .idlePrompt
            effects.append(.showStillReadingPrompt)
        }

        switch event {
        case .becameActive:
            if phase == .inactive {
                phase = .reading
                lastMark = t
                lastInteractionAt = t
            }

        case .becameInactive:
            if phase == .reading { accrue(to: t) }
            finalizePage()
            if phase == .idlePrompt { effects.append(.hidePrompt) }
            phase = .inactive

        case .interaction:
            if phase == .reading {
                accrue(to: t)
                lastInteractionAt = t
            }

        case .pageShown(_, let chars):
            switch phase {
            case .reading:
                accrue(to: t)
                finalizePage()
            case .idlePrompt:
                finalizePage()
                phase = .reading
                effects.append(.hidePrompt)
            case .inactive:
                finalizePage()
            }
            pageChars = chars
            lastMark = t
            lastInteractionAt = t

        case .promptAnswered(_, let stillReading):
            guard phase == .idlePrompt else { break }
            effects.append(.hidePrompt)
            if stillReading {
                phase = .reading
                lastMark = t
                lastInteractionAt = t
            } else {
                finalizePage()
                phase = .inactive
            }

        case .tick:
            if phase == .reading { accrue(to: t) }
        }
        return effects
    }

    private mutating func accrue(to t: Double) {
        let limit = min(t, lastInteractionAt + pace.idleTimeout)
        if limit > lastMark {
            pageAccrued += limit - lastMark
            lastMark = limit
        }
        // Keep the mark moving forward even past the idle limit, so time after it is never credited later.
        lastMark = max(lastMark, t)
    }

    private func inProgressCredit(_ accrued: Double) -> Double {
        accrued >= pace.minDwell(chars: pageChars) ? min(accrued, pace.maxDwell(chars: pageChars)) : 0
    }

    private mutating func finalizePage() {
        committedSeconds += inProgressCredit(pageAccrued)
        pageAccrued = 0
    }
}
