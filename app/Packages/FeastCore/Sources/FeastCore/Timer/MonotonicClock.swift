import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// A clock that keeps counting while the device sleeps and never jumps when the wall clock is changed.
///
/// `mach_continuous_time()` is used rather than `ProcessInfo.systemUptime` or `mach_absolute_time()`, which pause
/// during sleep. Pausing would make a session read before an overnight sleep look later than it was once the
/// server anchors it, and could turn a feast into a miss.
public protocol MonotonicClock: Sendable {
    /// Seconds since an arbitrary per-boot origin.
    func now() -> Double
}

public struct SystemMonotonicClock: MonotonicClock {
    private let numer: UInt64
    private let denom: UInt64

    public init() {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        numer = UInt64(info.numer)
        denom = UInt64(info.denom)
    }

    public func now() -> Double {
        let ticks = mach_continuous_time()
        let nanos = Double(ticks) * Double(numer) / Double(denom)
        return nanos / 1_000_000_000
    }

    public func nowMilliseconds() -> Int64 {
        Int64((now() * 1000).rounded(.down))
    }
}

/// Identifies the current boot so the server can tell monotonic origins apart.
///
/// Uses `kern.bootsessionuuid`, which is random per boot. `kern.boottime` is derived from the wall clock and shifts
/// when the clock is set, so it would make the server think the device rebooted.
public enum BootSession {
    public static func identifier() -> String {
        var size = 0
        if sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 {
            var buffer = [CChar](repeating: 0, count: size)
            if sysctlbyname("kern.bootsessionuuid", &buffer, &size, nil, 0) == 0 {
                let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
                let value = String(decoding: bytes, as: UTF8.self)
                if !value.isEmpty { return value.lowercased() }
            }
        }
        // Fallback: boot time rounded to the minute.
        var tv = timeval()
        size = MemoryLayout<timeval>.size
        if sysctlbyname("kern.boottime", &tv, &size, nil, 0) == 0 {
            return "boottime-\(tv.tv_sec / 60)"
        }
        return "unknown"
    }
}

/// A controllable clock for tests and previews.
public final class ManualClock: MonotonicClock, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double

    public init(_ start: Double = 0) { value = start }

    public func now() -> Double {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    public func advance(_ seconds: Double) {
        lock.lock(); value += seconds; lock.unlock()
    }
}
