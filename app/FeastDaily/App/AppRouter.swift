import Foundation
import Observation

enum Route: Hashable {
    case library
    case volume(Int)
    case book(Int)
    case reader(chapterId: Int)
    case history
    case settings
    case search
}

/// Navigation state, shared with App Intents and URL handling.
@MainActor
@Observable
final class AppRouter {
    static let shared = AppRouter()
    var path: [Route] = []
    /// Set by `feastdaily://read` or the "Start my reading" intent; consumed by Home.
    var pendingResume = false

    func handle(url: URL) {
        guard url.scheme == "feastdaily" else { return }
        switch url.host {
        case "read": pendingResume = true
        case "home": path = []
        default: break
        }
    }
}
