import SwiftUI
import FeastCore

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var deleting = false

    var body: some View {
        let settings = model.home?.settings
        Form {
            Section {
                Picker("Daily goal", selection: Binding(
                    get: { settings?.pendingGoalSeconds ?? settings?.goalSeconds ?? 300 },
                    set: { v in Task { await model.updateSettings(SettingsPatchDTO(goalSeconds: v)) } }
                )) {
                    ForEach(ScoringDisplay.goalOptions, id: \.self) { Text(ScoringDisplay.goalLabel(seconds: $0)).tag($0) }
                }
                if let pending = settings?.pendingGoalSeconds, pending != settings?.goalSeconds {
                    Text("Goal becomes \(ScoringDisplay.goalLabel(seconds: pending)) tomorrow. Today's finish line doesn't move.")
                        .font(.caption).foregroundStyle(Theme.muted)
                }
            } header: { Text("Reading") }

            Section {
                Toggle("Morning reminder", isOn: Binding(
                    get: { settings?.reminderEnabled ?? false },
                    set: { on in
                        Task {
                            await model.updateSettings(SettingsPatchDTO(
                                reminderEnabled: on, reminderLocalTime: on ? (settings?.reminderLocalTime ?? "06:30") : nil))
                        }
                    }
                ))
                if settings?.reminderEnabled == true {
                    DatePicker("Remind me at", selection: Binding(
                        get: {
                            let c = AppModel.parseHM(settings?.reminderLocalTime) ?? DateComponents(hour: 6, minute: 30)
                            return Calendar.current.date(from: c) ?? Date()
                        },
                        set: { d in
                            let c = Calendar.current.dateComponents([.hour, .minute], from: d)
                            Task { await model.updateSettings(SettingsPatchDTO(reminderLocalTime: AppModel.formatHM(c))) }
                        }
                    ), displayedComponents: .hourAndMinute)
                }
            } header: { Text("Notifications") }

            Section {
                NavigationLink("Reader appearance") { ReaderSettingsSheet() }
            }

            Section {
                if let url = BuildConfig.privacyPolicyURL { Link("Privacy policy", destination: url) }
                Button("Delete account and data", role: .destructive) { confirmDelete = true }
                    .disabled(deleting)
            } header: { Text("Privacy") } footer: {
                Text("Feast Daily keeps only an anonymous ID, your time zone, your settings and your reading times. No name, email or location.")
            }

            Section {
                Text("Feast Daily is an independent app, not affiliated with or endorsed by any church. Scripture text is the public domain edition from Scriptures in JSON by Ben Crowder.")
                    .font(.caption).foregroundStyle(Theme.muted)
                if let meta = try? model.scripture?.metadata(), let built = meta["built_at"] {
                    Text("Text database built \(built)").font(.caption2).foregroundStyle(Theme.muted)
                }
            } header: { Text("About") }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.parchment.ignoresSafeArea())
        .navigationTitle("Settings")
        .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete everything", role: .destructive) {
                deleting = true
                Task { _ = await model.deleteAccount(); deleting = false }
            }
        } message: {
            Text("Your streak, history and settings are removed from the server and this device. This can't be undone.")
        }
    }
}
