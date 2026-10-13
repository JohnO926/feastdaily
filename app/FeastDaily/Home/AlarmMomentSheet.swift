import SwiftUI
import FeastCore

/// The shared moment: when the alarm went off and how many readers beat it.
struct AlarmMomentSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let alarm: AlarmDTO

    var body: some View {
        let status = model.display.status
        VStack(spacing: 18) {
            Image(systemName: status == .safe ? "checkmark.seal.fill" : "alarm.fill")
                .font(.system(size: 54))
                .foregroundStyle(Theme.color(for: status))
                .padding(.top, 28)
            Text(status == .safe ? "You're safe today" : "The alarm went off")
                .accessibilityIdentifier("alarmMomentTitle")
                .font(Theme.title(28)).foregroundStyle(Theme.ink)
            if let firedAt = alarm.firedAt {
                Text("It went off at \(firedAt.formatted(date: .omitted, time: .shortened)).")
                    .font(.title3).foregroundStyle(Theme.ink)
            }
            if let pct = alarm.beatPct, let readers = alarm.readerCount {
                Text("\(Int(pct.rounded()))% of \(readers) \(readers == 1 ? "reader" : "readers") beat it.")
                    .font(.body).foregroundStyle(Theme.muted)
            }
            Text(momentCopy(status))
                .multilineTextAlignment(.center)
                .font(.callout).foregroundStyle(Theme.muted)
                .padding(.horizontal)
            Spacer()
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Theme.ink)
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity)
        .background(Theme.parchment.ignoresSafeArea())
        .presentationDetents([.medium])
    }

    private func momentCopy(_ status: DayStatus) -> String {
        switch status {
        case .safe: "Well fed. See you tomorrow."
        case .missed: "Today is a missed meal. Reading now still counts toward your history. Tomorrow, try reading first thing."
        case .racing, .notStarted: "Same moment for every reader, wherever they live."
        }
    }
}
