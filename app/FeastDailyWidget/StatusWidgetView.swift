import SwiftUI
import WidgetKit
import FeastCore

enum WidgetPalette {
    static let background = Color("WidgetBackground", bundle: nil)
    static func color(_ s: DayStatus) -> Color {
        switch s {
        case .safe: Color(red: 0.40, green: 0.58, blue: 0.30)
        case .racing: Color(red: 0.85, green: 0.56, blue: 0.20)
        case .missed: Color(red: 0.70, green: 0.32, blue: 0.30)
        case .notStarted: .gray
        }
    }
    static func word(_ s: DayStatus) -> String {
        switch s {
        case .safe: "Safe"
        case .racing: "Exposed"
        case .missed: "Missed"
        case .notStarted: "Soon"
        }
    }
}

struct StatusWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatusEntry
    private var s: WidgetSnapshot { entry.snapshot }

    var body: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .accessoryInline: inline
        case .systemMedium: medium
        default: small
        }
    }

    private var ring: some View {
        ZStack {
            Circle().stroke(WidgetPalette.color(s.status).opacity(0.2), lineWidth: 8)
            Circle().trim(from: 0, to: max(0.001, s.progress))
                .stroke(WidgetPalette.color(s.status), style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: s.status == .safe ? "checkmark" : "fork.knife")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(WidgetPalette.color(s.status))
        }
    }

    private var marks: some View {
        HStack(spacing: 3) {
            ForEach(0..<s.famineThreshold, id: \.self) { i in
                Image(systemName: i < min(s.activeMissedMeals, s.famineThreshold) ? "circle.fill" : "circle")
                    .font(.system(size: 7))
                    .foregroundStyle(i < s.activeMissedMeals ? WidgetPalette.color(.missed) : .secondary)
            }
        }
        .accessibilityLabel("\(s.activeMissedMeals) missed meals")
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 6) {
            ring.frame(width: 54, height: 54)
            Spacer(minLength: 0)
            Text(WidgetPalette.word(s.status)).font(.system(.headline, design: .serif))
                .foregroundStyle(WidgetPalette.color(s.status))
            HStack(spacing: 6) {
                Label("\(s.streak)", systemImage: "flame").font(.caption.bold())
                marks
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var medium: some View {
        HStack(spacing: 16) {
            ring.frame(width: 76, height: 76)
            VStack(alignment: .leading, spacing: 4) {
                Text(WidgetPalette.word(s.status)).font(.system(.title3, design: .serif).bold())
                    .foregroundStyle(WidgetPalette.color(s.status))
                Text("\(ScoringDisplay.durationLabel(seconds: s.verifiedSeconds)) of \(ScoringDisplay.goalLabel(seconds: s.goalSeconds))")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Label("\(s.streak) day streak", systemImage: "flame").font(.caption.bold())
                    marks
                }
                if let fired = s.alarmFiredAt {
                    Text("Alarm at \(fired.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(.secondary)
                } else if let title = s.resumeTitle {
                    Text("Continue \(title)").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var circular: some View {
        Gauge(value: s.progress) {
            Image(systemName: "fork.knife")
        } currentValueLabel: {
            Image(systemName: s.status == .safe ? "checkmark" : "fork.knife")
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .widgetAccentable()
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(s.status == .safe ? "Safe today" : s.status == .missed ? "Missed meal" : "Not safe yet")
                .font(.headline).widgetAccentable()
            Text("\(s.streak) day streak").font(.caption)
            HStack(spacing: 4) {
                Text("Missed").font(.caption2)
                marks
            }
        }
    }

    private var inline: some View {
        Text(s.status == .safe ? "Safe today · \(s.streak) day streak" : "\(WidgetPalette.word(s.status)) · \(s.streak) day streak")
    }
}

#Preview(as: .systemSmall) {
    StatusWidget()
} timeline: {
    StatusEntry(date: .now, snapshot: .placeholder)
}
