import SwiftUI
import SwiftData
import UserNotifications
import FeastCore

@main
struct FeastDailyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.router)
                .modelContainer(model.container)
                .preferredColorScheme(model.localSettings.appearance.colorScheme)
                .task {
                    delegate.model = model
                    await model.start()
                }
                .onOpenURL { model.router.handle(url: $0) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.onForeground() } }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .launching:
            ProgressView().controlSize(.large)
        case .onboarding:
            OnboardingView()
        case .ready:
            HomeView()
        }
    }
}

extension LocalSettings.Appearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor var model: AppModel?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if BuildConfig.alarmMode == .push { application.registerForRemoteNotifications() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // Gated on push mode: the simulator "succeeds" here with a fake token.
        guard BuildConfig.alarmMode == .push else { return }
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            guard let model else { return }
            #if DEBUG
            let environment = "sandbox"
            #else
            let environment = "production"
            #endif
            try? await model.api.registerDevice(deviceId: model.auth.identity().deviceId, token: token,
                                                environment: environment)
        }
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async
        -> UIBackgroundFetchResult {
        // `content-available` on the alarm push: refresh state and the widget in the background.
        await alarmArrived(userInfo)
        return .newData
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        if Self.isAlarm(info) { await alarmArrived(info) }
        return [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        if Self.isAlarm(info) {
            await alarmArrived(info)
        } else {
            await MainActor.run { AppRouter.shared.pendingResume = true }
        }
    }

    private static func isAlarm(_ info: [AnyHashable: Any]) -> Bool {
        let kind = info["kind"] as? String
        return kind == "alarm" || kind == "safe" || kind == "moment"
    }

    @MainActor
    private func alarmArrived(_ info: [AnyHashable: Any]) async {
        // The push kind is only the server's view at fire time; the app always trusts the refetched home state.
        await model?.alarmArrived(alarmDate: info["alarm_date"] as? String)
    }
}
