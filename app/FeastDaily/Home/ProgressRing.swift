import SwiftUI

struct ProgressRing<Label: View>: View {
    let progress: Double
    let color: Color
    var lineWidth: CGFloat = 16
    @ViewBuilder let label: () -> Label

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.15), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.001, progress))
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.4), value: progress)
            label()
        }
        .padding(lineWidth / 2)
    }
}
