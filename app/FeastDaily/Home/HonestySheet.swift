import SwiftUI
import FeastCore

/// "I read today" for reading outside the app. Honor system, and only before the alarm.
struct HonestySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var line: String = {
        var rng = SystemRandomNumberGenerator()
        return HonestyCopy.line(using: &rng)
    }()

    var body: some View {
        VStack(spacing: 20) {
            Text("Did you really read?")
                .font(Theme.title(26)).foregroundStyle(Theme.ink)
                .padding(.top, 28)
            Text("\u{201C}\(line)\u{201D}")
                .font(.system(.title3, design: .serif).italic())
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.ink)
                .padding(.horizontal)
            Text(HonestyCopy.explanation)
                .font(.callout).multilineTextAlignment(.center).foregroundStyle(Theme.muted)
                .padding(.horizontal)
            Spacer()
            Button {
                Task {
                    await model.selfReport()
                    dismiss()
                }
            } label: {
                Text("Yes, I read today").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.safe)
            .accessibilityIdentifier("confirmSelfReport")
            Button("Not yet") { dismiss() }
                .foregroundStyle(Theme.muted)
                .padding(.bottom, 20)
        }
        .padding(.horizontal, 24)
        .background(Theme.parchment.ignoresSafeArea())
        .presentationDetents([.medium, .large])
    }
}
