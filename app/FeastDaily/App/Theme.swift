import SwiftUI
import FeastCore

/// Warm, quiet palette: parchment and ink, with olive for safe and a muted wine for a missed meal.
enum Theme {
    static let parchment = Color(light: .init(red: 0.98, green: 0.96, blue: 0.91, alpha: 1), dark: .init(red: 0.10, green: 0.09, blue: 0.08, alpha: 1))
    static let card = Color(light: .init(red: 1.0, green: 0.99, blue: 0.96, alpha: 1), dark: .init(red: 0.16, green: 0.14, blue: 0.12, alpha: 1))
    static let ink = Color(light: .init(red: 0.17, green: 0.14, blue: 0.11, alpha: 1), dark: .init(red: 0.94, green: 0.91, blue: 0.85, alpha: 1))
    static let muted = Color(light: .init(red: 0.45, green: 0.40, blue: 0.34, alpha: 1), dark: .init(red: 0.66, green: 0.61, blue: 0.54, alpha: 1))
    static let safe = Color(light: .init(red: 0.33, green: 0.47, blue: 0.24, alpha: 1), dark: .init(red: 0.56, green: 0.72, blue: 0.43, alpha: 1))
    static let racing = Color(light: .init(red: 0.76, green: 0.48, blue: 0.13, alpha: 1), dark: .init(red: 0.93, green: 0.66, blue: 0.30, alpha: 1))
    static let missed = Color(light: .init(red: 0.55, green: 0.22, blue: 0.22, alpha: 1), dark: .init(red: 0.82, green: 0.45, blue: 0.43, alpha: 1))

    static func color(for status: DayStatus) -> Color {
        switch status {
        case .safe: safe
        case .racing: racing
        case .missed: missed
        case .notStarted: muted
        }
    }

    static func title(_ size: CGFloat = 28) -> Font { .system(size: size, weight: .semibold, design: .serif) }
}

extension Color {
    init(light: UIColor, dark: UIColor) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

struct CardBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.muted.opacity(0.15)))
    }
}

extension View {
    func card() -> some View { modifier(CardBackground()) }
}
