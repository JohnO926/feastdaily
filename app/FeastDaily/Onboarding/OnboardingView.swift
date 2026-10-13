import SwiftUI
import FeastCore

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var step = 0
    @State private var goal = 300
    @State private var rolloverHour = 3
    @State private var reminderOn = true
    @State private var reminderTime = Calendar.current.date(from: DateComponents(hour: 6, minute: 30)) ?? Date()
    @State private var submitting = false

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $step) {
                welcome.tag(0)
                goalStep.tag(1)
                timingStep.tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))

            Button(action: next) {
                Group {
                    if submitting { ProgressView().tint(Theme.parchment) } else { Text(step < 2 ? "Continue" : "Start feasting") }
                }
                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                .foregroundStyle(Theme.parchment)
                .background(Theme.ink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .disabled(submitting)
            .accessibilityIdentifier("onboardingNext")
            .padding(24)
            if let error = model.lastError, step == 2 {
                Text(error).font(.caption).foregroundStyle(Theme.missed).padding(.horizontal).padding(.bottom)
            }
        }
        .background(Theme.parchment.ignoresSafeArea())
    }

    private var welcome: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "fork.knife.circle").font(.system(size: 64)).foregroundStyle(Theme.ink)
            Text("Feast Daily").font(Theme.title(36)).foregroundStyle(Theme.ink)
            Text("\u{201C}\(HonestyCopy.verse)\u{201D}")
                .font(.system(.body, design: .serif).italic()).multilineTextAlignment(.center)
                .foregroundStyle(Theme.ink)
            Text(HonestyCopy.reference).font(.caption).foregroundStyle(Theme.muted)
            Text("Once a day, at a random moment between 10:00 AM and 8:30 PM Mountain Time, an alarm goes off for everyone at once. Finish your reading before it does and the day is a feast.")
                .font(.callout).multilineTextAlignment(.center).foregroundStyle(Theme.muted)
            Spacer()
            Text("Feast Daily is an independent app and is not affiliated with any church.")
                .font(.caption2).foregroundStyle(Theme.muted)
        }
        .padding(28)
    }

    private var goalStep: some View {
        VStack(spacing: 18) {
            Spacer()
            Text("Your daily goal").font(Theme.title(28)).foregroundStyle(Theme.ink)
            Text("Even under a minute builds the habit. You can change it later; changes start the next day.")
                .font(.callout).multilineTextAlignment(.center).foregroundStyle(Theme.muted)
            Picker("Goal", selection: $goal) {
                ForEach(ScoringDisplay.goalOptions, id: \.self) { Text(ScoringDisplay.goalLabel(seconds: $0)).tag($0) }
            }
            .pickerStyle(.wheel)
            .accessibilityIdentifier("goalPicker")
            Spacer()
        }
        .padding(28)
    }

    private var timingStep: some View {
        Form {
            Section {
                Picker("New day starts at", selection: $rolloverHour) {
                    ForEach(0...9, id: \.self) { h in Text(hourLabel(h)).tag(h) }
                }
            } footer: {
                Text("Late-night reading counts for the day it belongs to. Most people keep 3 AM.")
            }
            Section {
                Toggle("Morning reminder", isOn: $reminderOn)
                if reminderOn {
                    DatePicker("Remind me at", selection: $reminderTime, displayedComponents: .hourAndMinute)
                }
            } footer: {
                Text("A gentle nudge to read before the alarm window opens. There's no safe time to put it off.")
            }
            if let issue = reminderIssue {
                Text(issue).font(.caption).foregroundStyle(Theme.missed)
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var reminderComponents: DateComponents? {
        reminderOn ? Calendar.current.dateComponents([.hour, .minute], from: reminderTime) : nil
    }

    private var reminderIssue: String? {
        guard let c = reminderComponents, let h = c.hour else { return nil }
        return h < rolloverHour ? "The reminder has to be after the new day starts (\(hourLabel(rolloverHour)))." : nil
    }

    private func hourLabel(_ h: Int) -> String {
        Calendar.current.date(from: DateComponents(hour: h))?.formatted(date: .omitted, time: .shortened) ?? "\(h):00"
    }

    private func next() {
        if step < 2 {
            withAnimation { step += 1 }
            return
        }
        guard reminderIssue == nil else { return }
        submitting = true
        Task {
            await model.completeOnboarding(goalSeconds: goal, rolloverHour: rolloverHour, reminder: reminderComponents)
            submitting = false
        }
    }
}
