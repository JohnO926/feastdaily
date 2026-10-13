import Foundation

/// Display helpers for streaks and missed meals. The server decides the numbers; this only formats them.
public enum ScoringDisplay {
    /// Number of missed-meal marks to draw next to the handle and on the widget.
    public static func marks(activeMissedMeals: Int, famineThreshold: Int) -> Int {
        max(0, min(activeMissedMeals, famineThreshold))
    }

    public static func goalLabel(seconds: Int) -> String {
        if seconds < 60 { return "\(seconds) sec" }
        let m = seconds / 60, s = seconds % 60
        if s == 0 { return m == 1 ? "1 min" : "\(m) min" }
        return "\(m):\(String(format: "%02d", s))"
    }

    public static func durationLabel(seconds: Double) -> String {
        let total = Int(seconds.rounded(.down))
        let m = total / 60, s = total % 60
        return String(format: "%d:%02d", m, s)
    }

    /// Allowed goal values: 45 s to 5 min in 15 s steps, then 1 min steps to 45 min.
    public static let goalOptions: [Int] = {
        Array(stride(from: 45, through: 300, by: 15)) + Array(stride(from: 360, through: 2700, by: 60))
    }()

    public static func isValidGoal(_ seconds: Int) -> Bool { goalOptions.contains(seconds) }

    public static func statusTitle(_ status: DayStatus) -> String {
        switch status {
        case .notStarted: "Your first day starts at rollover"
        case .racing: "Exposed"
        case .safe: "Safe today"
        case .missed: "Missed meal"
        }
    }
}
