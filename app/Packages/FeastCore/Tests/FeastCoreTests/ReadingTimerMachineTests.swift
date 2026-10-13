import Testing
@testable import FeastCore

@Suite("Reading timer")
struct ReadingTimerMachineTests {
    let full = 1_200  // one full screen of text

    func started(chars: Int = 1_200) -> ReadingTimerMachine {
        var m = ReadingTimerMachine(initialPageChars: chars)
        m.apply(.becameActive(at: 0))
        return m
    }

    @Test func accruesOneToOneWhileReading() {
        var m = started()
        for t in 1...30 { m.apply(.tick(at: Double(t))) }
        #expect(m.verifiedSeconds == 30)
        #expect(m.phase == .reading)
    }

    @Test func idlePromptAtSixtySecondsCreditsOnlyUpToTheLimit() {
        var m = started()
        var effects: [TimerEffect] = []
        for t in 1...90 { effects += m.apply(.tick(at: Double(t))) }
        #expect(effects == [.showStillReadingPrompt])
        #expect(m.phase == .idlePrompt)
        #expect(m.verifiedSeconds == 60)
    }

    @Test func resumingAfterPromptGivesNoCreditForTheGap() {
        var m = started()
        for t in 1...90 { m.apply(.tick(at: Double(t))) }
        let effects = m.apply(.promptAnswered(at: 120, stillReading: true))
        #expect(effects == [.hidePrompt])
        for t in 121...130 { m.apply(.tick(at: Double(t))) }
        #expect(m.verifiedSeconds == 70)
    }

    @Test func interactionsKeepTheTimerAlive() {
        var m = started()
        for t in stride(from: 50, through: 200, by: 50) { m.apply(.interaction(at: Double(t))) }
        m.apply(.tick(at: 210))
        #expect(m.phase == .reading)
        #expect(m.verifiedSeconds == 210)
    }

    @Test func pageTurnCountsAsInteraction() {
        var m = started()
        // Turn a page every 50 s with no other interaction: never idle.
        for t in stride(from: 50, through: 300, by: 50) { m.apply(.pageShown(at: Double(t), chars: full)) }
        #expect(m.phase == .reading)
        #expect(m.verifiedSeconds == 300)
    }

    @Test func fastPageTurnOnAFullScreenIsDiscarded() {
        var m = started()
        m.apply(.pageShown(at: 1.5, chars: full))
        #expect(m.verifiedSeconds == 0)
    }

    @Test func pageReadForFourSecondsIsKept() {
        var m = started()
        m.apply(.pageShown(at: 4, chars: full))
        #expect(m.verifiedSeconds == 4)
    }

    @Test func shortPageNeedsProportionallyLessTime() {
        let pace = PaceRule()
        #expect(pace.minDwell(chars: 200) == 0.5)
        var m = started(chars: 200)
        m.apply(.pageShown(at: 0.6, chars: full))
        #expect(abs(m.verifiedSeconds - 0.6) < 1e-9)
    }

    @Test func flickingThroughPagesEarnsNothing() {
        var m = started()
        for i in 1...100 { m.apply(.pageShown(at: Double(i) * 1.0, chars: full)) }
        #expect(m.verifiedSeconds == 0)
    }

    @Test func onePageCreditIsCapped() {
        // Tap every 50 s on the same page for an hour: credit stops at maxDwell.
        var m = started()
        for t in stride(from: 50, through: 3_600, by: 50) { m.apply(.interaction(at: Double(t))) }
        let cap = PaceRule().maxDwell(chars: full)
        #expect(m.verifiedSeconds == cap)
        #expect(cap < 45 * 60)
    }

    @Test func inactiveFreezesAndActiveResumesWithoutCreditingTheGap() {
        var m = started()
        m.apply(.tick(at: 10))
        m.apply(.becameInactive(at: 10))
        #expect(m.phase == .inactive)
        m.apply(.becameActive(at: 500))
        m.apply(.tick(at: 520))
        #expect(m.verifiedSeconds == 30)
    }

    @Test func decreasingTimestampsAreIgnored() {
        var m = started()
        m.apply(.tick(at: 20))
        m.apply(.tick(at: 5))
        m.apply(.interaction(at: 3))
        #expect(m.verifiedSeconds == 20)
    }

    @Test func liveValueMatchesTheAppliedValue() {
        var m = started()
        m.apply(.tick(at: 10))
        let predicted = m.verifiedSeconds(at: 25)
        m.apply(.tick(at: 25))
        #expect(predicted == m.verifiedSeconds)
        #expect(m.verifiedSeconds(at: 500) == 60)  // never past the idle limit
    }

    @Test func verifiedSecondsNeverDecreasesOverRandomSequences() {
        var rng = SeededGenerator(seed: 42)
        for _ in 0..<200 {
            var m = ReadingTimerMachine(initialPageChars: 800)
            var t = 0.0
            var last = 0.0
            for _ in 0..<300 {
                t += Double.random(in: 0...8, using: &rng)
                let event: ReadingTimerEvent
                switch Int.random(in: 0..<7, using: &rng) {
                case 0: event = .becameActive(at: t)
                case 1: event = .becameInactive(at: t)
                case 2: event = .interaction(at: t)
                case 3: event = .pageShown(at: t, chars: Int.random(in: 0...2_000, using: &rng))
                case 4: event = .promptAnswered(at: t, stillReading: Bool.random(using: &rng))
                case 5: event = .tick(at: t - Double.random(in: 0...20, using: &rng))  // sometimes out of order
                default: event = .tick(at: t)
                }
                m.apply(event)
                #expect(m.verifiedSeconds >= last)
                #expect(m.verifiedSeconds <= t + 1e-9)
                last = m.verifiedSeconds
            }
        }
    }
}

/// Deterministic generator for property tests (SplitMix64).
struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
