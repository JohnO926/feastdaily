import SwiftUI
import WidgetKit
import FeastCore

struct StatusEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct StatusTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(StatusEntry(date: Date(), snapshot: SnapshotStore().load() ?? .placeholder))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        Task {
            let store = SnapshotStore()
            var snapshot = store.load()
            // One best-effort refresh so the widget is right even on days the app is never opened.
            if let token = Keychain().read(.apiToken),
               let home = await WidgetHomeFetcher.fetch(baseURL: Self.baseURL, token: token) {
                let fresh = WidgetSnapshot.from(home: home, previous: snapshot, now: home.serverNow)
                store.save(fresh)
                snapshot = fresh
            }
            guard let snapshot else {
                completion(Timeline(entries: [StatusEntry(date: Date(), snapshot: .placeholder)],
                                    policy: .after(Date().addingTimeInterval(3600))))
                return
            }
            let now = Date()
            let entries = snapshot.timeline(now: now).map { StatusEntry(date: $0.date, snapshot: $0.snapshot) }
            let reload = entries.dropFirst().first?.date ?? now.addingTimeInterval(3600)
            completion(Timeline(entries: entries, policy: .after(min(reload, now.addingTimeInterval(4 * 3600)))))
        }
    }

    static var baseURL: URL {
        let raw = Bundle.main.object(forInfoDictionaryKey: "FDAPIBaseURL") as? String ?? ""
        return URL(string: raw.isEmpty ? "http://localhost:3000" : raw)!
    }
}

struct StatusWidget: Widget {
    let kind = "FeastDailyStatus"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StatusTimelineProvider()) { entry in
            StatusWidgetView(entry: entry)
                .containerBackground(for: .widget) { WidgetPalette.background }
                .widgetURL(URL(string: "feastdaily://read"))
        }
        .configurationDisplayName("Today's feast")
        .description("Whether you're safe today, your feast streak, and missed meals.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct FeastDailyWidgetBundle: WidgetBundle {
    var body: some Widget { StatusWidget() }
}
