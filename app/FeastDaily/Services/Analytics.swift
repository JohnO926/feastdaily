import Foundation
import TelemetryDeck

/// Anonymous product analytics (TelemetryDeck; no ad SDKs).
///
/// Only coarse events go out: never scripture references, chapter ids or reading content. Reading habits in a
/// scripture app are sensitive data under GDPR and several US state laws. Disabled when no app ID is configured.
@MainActor
final class Analytics {
    private let enabled: Bool

    init(appID: String?) {
        if let appID, !BuildConfig.isUITesting {
            TelemetryDeck.initialize(config: TelemetryDeck.Config(appID: appID))
            enabled = true
        } else {
            enabled = false
        }
    }

    func signal(_ name: String, _ parameters: [String: String] = [:]) {
        guard enabled else { return }
        TelemetryDeck.signal(name, parameters: parameters)
    }
}
