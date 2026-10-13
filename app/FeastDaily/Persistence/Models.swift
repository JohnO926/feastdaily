import Foundation
import SwiftData
import FeastCore

/// A slice of reading (or a self-report) waiting to sync. Slices are cut every minute, when the goal is crossed,
/// at rollover and at the alarm, so the server sees progress promptly and never has to guess.
@Model
final class PendingSession {
    enum SyncState: String, Codable { case pending, synced, rejected }

    @Attribute(.unique) var id: UUID
    var sourceRaw: String
    var bootId: String
    var startedAtWall: Date
    var endedAtWall: Date
    var monoStartMs: Int64
    var monoEndMs: Int64
    var activeSeconds: Double
    var contentRef: String?
    /// Still being written by the timer driver. Rows left open by a crash are closed at their last checkpoint.
    var isOpen: Bool
    var syncStateRaw: String
    var rejectReason: String?
    var serverDayKey: String?
    /// Best estimate of the end instant on the server's clock, used to merge unsynced time into today.
    var estimatedServerEnd: Date

    init(id: UUID = UUID(), source: SessionSource, bootId: String, startedAtWall: Date, monoStartMs: Int64,
         contentRef: String?, estimatedServerEnd: Date) {
        self.id = id
        self.sourceRaw = source.rawValue
        self.bootId = bootId
        self.startedAtWall = startedAtWall
        self.endedAtWall = startedAtWall
        self.monoStartMs = monoStartMs
        self.monoEndMs = monoStartMs
        self.activeSeconds = 0
        self.contentRef = contentRef
        self.isOpen = true
        self.syncStateRaw = SyncState.pending.rawValue
        self.estimatedServerEnd = estimatedServerEnd
    }

    var source: SessionSource { SessionSource(rawValue: sourceRaw) ?? .reader }
    var syncState: SyncState {
        get { SyncState(rawValue: syncStateRaw) ?? .pending }
        set { syncStateRaw = newValue.rawValue }
    }

    var upload: SessionUploadDTO {
        SessionUploadDTO(id: id, source: source, bootId: bootId, startedAtWall: startedAtWall,
                         endedAtWall: endedAtWall, monoStartMs: monoStartMs, monoEndMs: monoEndMs,
                         activeSeconds: Int(activeSeconds.rounded(.down)), contentRef: contentRef)
    }

    var summary: LocalSessionSummary {
        LocalSessionSummary(source: source, activeSeconds: activeSeconds, endedAt: estimatedServerEnd)
    }
}

/// Where the reader left off. A single row.
@Model
final class ReadingPosition {
    var chapterId: Int
    var pageIndex: Int
    var verseNumber: Int
    var updatedAt: Date

    init(chapterId: Int, pageIndex: Int = 0, verseNumber: Int = 1) {
        self.chapterId = chapterId
        self.pageIndex = pageIndex
        self.verseNumber = verseNumber
        self.updatedAt = Date()
    }
}

/// The last `/home` response, so the app and widget work offline. A single row.
@Model
final class HomeStateCache {
    var json: Data
    var fetchedAt: Date
    /// Monotonic time when it was fetched, to derive "server now" without trusting the device clock.
    var fetchedMonoSeconds: Double
    var bootId: String

    init(json: Data, fetchedAt: Date, fetchedMonoSeconds: Double, bootId: String) {
        self.json = json
        self.fetchedAt = fetchedAt
        self.fetchedMonoSeconds = fetchedMonoSeconds
        self.bootId = bootId
    }
}

/// History days fetched from the server, for offline viewing.
@Model
final class DailyResultCache {
    @Attribute(.unique) var dayKey: String
    var resultRaw: String?
    var verifiedSeconds: Int
    var selfReported: Bool
    var alarmAt: Date?
    var goalSeconds: Int?
    var fetchedAt: Date

    init(_ dto: HistoryDayDTO) {
        dayKey = dto.dayKey.description
        resultRaw = dto.result?.rawValue
        verifiedSeconds = dto.verifiedSeconds
        selfReported = dto.selfReported
        alarmAt = dto.alarmAt
        goalSeconds = dto.goalSeconds
        fetchedAt = Date()
    }

    func update(_ dto: HistoryDayDTO) {
        resultRaw = dto.result?.rawValue
        verifiedSeconds = dto.verifiedSeconds
        selfReported = dto.selfReported
        alarmAt = dto.alarmAt
        goalSeconds = dto.goalSeconds
        fetchedAt = Date()
    }

    var result: DayResult? { resultRaw.flatMap(DayResult.init(rawValue:)) }
}

/// Device-local preferences. A single row.
@Model
final class LocalSettings {
    enum ReaderMode: String, Codable, CaseIterable { case paginated, scroll }
    enum Appearance: String, Codable, CaseIterable { case system, light, dark }

    var readerModeRaw: String
    var fontSize: Double
    var appearanceRaw: String
    var onboarded: Bool
    var lastSentTimeZone: String?
    /// Alarm instants this device has already shown the moment sheet for.
    var revealedAlarmDates: [String]

    init() {
        readerModeRaw = ReaderMode.paginated.rawValue
        fontSize = 19
        appearanceRaw = Appearance.system.rawValue
        onboarded = false
        revealedAlarmDates = []
    }

    var readerMode: ReaderMode {
        get { ReaderMode(rawValue: readerModeRaw) ?? .paginated }
        set { readerModeRaw = newValue.rawValue }
    }

    var appearance: Appearance {
        get { Appearance(rawValue: appearanceRaw) ?? .system }
        set { appearanceRaw = newValue.rawValue }
    }
}

enum Persistence {
    static let schema = Schema([PendingSession.self, ReadingPosition.self, HomeStateCache.self,
                                DailyResultCache.self, LocalSettings.self])

    /// The app's own container. Deliberately not in the App Group: the widget never opens SwiftData.
    static func makeContainer(inMemory: Bool = false) -> ModelContainer {
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory)
        do {
            return try ModelContainer(for: schema, configurations: config)
        } catch {
            fatalError("Could not open the local database: \(error)")
        }
    }
}
