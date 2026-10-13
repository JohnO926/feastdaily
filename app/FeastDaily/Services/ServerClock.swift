import Foundation
import FeastCore

/// "Now" on the server's clock: the last `server_now` plus monotonic time elapsed since it was fetched.
///
/// Day logic (session splits, notification planning) uses this instead of `Date()`, so a phone whose clock is off
/// by hours or a day still splits sessions and plans alarms at the right instants. Falls back to the device clock
/// before the first sync or after a reboot.
struct ServerClock: Sendable {
    let mono: SystemMonotonicClock
    var anchorServer: Date?
    var anchorMono: Double?
    var anchorBoot: String?

    init(mono: SystemMonotonicClock = SystemMonotonicClock()) {
        self.mono = mono
    }

    mutating func anchor(serverNow: Date, monoSeconds: Double, bootId: String) {
        anchorServer = serverNow
        anchorMono = monoSeconds
        anchorBoot = bootId
    }

    func now(currentBoot: String) -> Date {
        guard let anchorServer, let anchorMono, anchorBoot == currentBoot else { return Date() }
        return anchorServer.addingTimeInterval(mono.now() - anchorMono)
    }

    /// Server-clock estimate of a past monotonic instant on this boot.
    func instant(atMono seconds: Double, currentBoot: String) -> Date {
        let current = now(currentBoot: currentBoot)
        return current.addingTimeInterval(seconds - mono.now())
    }
}
