import XCTest
import SwiftData
import UserNotifications
import FeastCore
@testable import Feast_Daily

final class PersistenceTests: XCTestCase {
    @MainActor
    func testPendingSessionRoundTrip() throws {
        let container = Persistence.makeContainer(inMemory: true)
        let context = container.mainContext
        let s = PendingSession(source: .reader, bootId: "boot", startedAtWall: Date(), monoStartMs: 1_000,
                               contentRef: "book-of-mormon/2-nephi/32", estimatedServerEnd: Date())
        s.activeSeconds = 42.7
        s.monoEndMs = 50_000
        context.insert(s)
        try context.save()

        let fetched = try XCTUnwrap(try context.fetch(FetchDescriptor<PendingSession>()).first)
        XCTAssertEqual(fetched.upload.activeSeconds, 42)
        XCTAssertEqual(fetched.upload.source, .reader)
        XCTAssertEqual(fetched.syncState, .pending)
        XCTAssertTrue(fetched.isOpen)
    }

    @MainActor
    func testLocalSettingsDefaults() {
        let s = LocalSettings()
        XCTAssertEqual(s.readerMode, .paginated)
        XCTAssertEqual(s.appearance, .system)
        XCTAssertFalse(s.onboarded)
    }
}

final class SnapshotStoreTests: XCTestCase {
    func testRoundTripThroughSharedDefaults() {
        let store = SnapshotStore(suiteName: "test.\(UUID().uuidString)")
        XCTAssertNil(store.load())
        store.save(.placeholder)
        XCTAssertEqual(store.load()?.streak, WidgetSnapshot.placeholder.streak)
        store.clear()
        XCTAssertNil(store.load())
    }

    func testTimelineEndsWithAFreshDay() {
        var s = WidgetSnapshot.placeholder
        let now = Date()
        s.status = .racing
        s.alarmWindowEnd = now.addingTimeInterval(3600)
        s.nextRollover = now.addingTimeInterval(7200)
        let t = s.timeline(now: now)
        XCTAssertEqual(t.count, 3)
        XCTAssertEqual(t[1].snapshot.status, .missed)
        XCTAssertEqual(t[2].snapshot.status, .racing)
        XCTAssertEqual(t[2].snapshot.streak, 0)
    }
}

final class FakeCenter: NotificationCenterProtocol, @unchecked Sendable {
    var pending: [String: Date] = [:]
    var added: [String] = []
    var removed: [String] = []
    func pendingIdentifiers() async -> [String: Date] { pending }
    func add(_ request: UNNotificationRequest) async throws {
        added.append(request.identifier)
        pending[request.identifier] = (request.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()
    }
    func remove(_ identifiers: [String]) {
        removed += identifiers
        identifiers.forEach { pending[$0] = nil }
    }
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool { true }
}

final class NotificationPlannerTests: XCTestCase {
    @MainActor
    func testApplyRemovesStaleAndAddsWanted() async {
        let center = FakeCenter()
        center.pending = ["alarm-2020-01-01": Date(), "reminder-2020-01-01": Date(), "other": Date()]
        let planner = NotificationPlanner(center: center)
        let at = Date().addingTimeInterval(3600)
        await planner.apply([NotificationPlanner.alarmNotification(date: "2030-01-01", at: at, safe: false)])
        XCTAssertEqual(Set(center.removed).intersection(["alarm-2020-01-01", "reminder-2020-01-01"]).count, 2)
        XCTAssertFalse(center.removed.contains("other"), "Only managed notifications are touched")
        XCTAssertEqual(center.added, ["alarm-2030-01-01"])
    }

    @MainActor
    func testSafeVariantReplacesTheAlarm() async {
        let center = FakeCenter()
        let planner = NotificationPlanner(center: center)
        let at = Date().addingTimeInterval(3600)
        await planner.apply([NotificationPlanner.alarmNotification(date: "2030-01-01", at: at, safe: false)])
        await planner.apply([NotificationPlanner.alarmNotification(date: "2030-01-01", at: at, safe: true)])
        XCTAssertEqual(center.added.count, 2, "A changed variant is re-added; notifications can't be edited in place")
        let unchanged = center.added.count
        await planner.apply([NotificationPlanner.alarmNotification(date: "2030-01-01", at: at, safe: true)])
        XCTAssertEqual(center.added.count, unchanged, "An unchanged plan is a no-op")
    }

    func testDeterministicLocalAlarm() {
        var a = DateSeededGenerator(seed: "2026-10-12")
        var b = DateSeededGenerator(seed: "2026-10-12")
        let key = DayKey("2026-10-12")!
        XCTAssertEqual(AlarmWindow.standard.randomInstant(on: key, using: &a),
                       AlarmWindow.standard.randomInstant(on: key, using: &b))
    }
}

final class PaginatorTests: XCTestCase {
    func testPagesCoverTheWholeTextWithoutGaps() {
        let verses = (1...40).map { n in
            FeastScriptureVerse.make(n, String(repeating: "And it came to pass that the word of the Lord came. ", count: 3))
        }
        let typo = ChapterTypography(fontSize: 19, isDark: false)
        let text = typo.attributedChapter(heading: nil, verses: verses)
        let pages = ChapterPaginator.pages(for: text, size: CGSize(width: 340, height: 600))
        XCTAssertGreaterThan(pages.count, 1)
        XCTAssertEqual(pages.first?.location, 0)
        for (a, b) in zip(pages, pages.dropFirst()) { XCTAssertEqual(NSMaxRange(a), b.location) }
        XCTAssertEqual(NSMaxRange(pages.last!), text.length)
    }

    func testLargerTextMakesMorePages() {
        let verses = (1...40).map { FeastScriptureVerse.make($0, String(repeating: "word ", count: 40)) }
        let small = ChapterTypography(fontSize: 14, isDark: false).attributedChapter(heading: nil, verses: verses)
        let large = ChapterTypography(fontSize: 30, isDark: false).attributedChapter(heading: nil, verses: verses)
        let size = CGSize(width: 340, height: 600)
        XCTAssertGreaterThan(ChapterPaginator.pages(for: large, size: size).count,
                             ChapterPaginator.pages(for: small, size: size).count)
    }
}

import FeastScripture
enum FeastScriptureVerse {
    static func make(_ n: Int, _ text: String) -> Verse {
        Verse(id: n, chapterId: 1, number: n, reference: "Test 1:\(n)", text: text)
    }
}
