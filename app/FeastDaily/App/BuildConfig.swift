import Foundation

/// Values injected from the xcconfig through Info.plist.
enum BuildConfig {
    enum AlarmMode: String { case localSimulation = "LOCAL_SIM", push = "PUSH" }

    static var apiBaseURL: URL {
        let raw = Bundle.main.object(forInfoDictionaryKey: "FDAPIBaseURL") as? String ?? ""
        return URL(string: raw.isEmpty ? "http://localhost:3000" : raw)!
    }

    static var alarmMode: AlarmMode {
        AlarmMode(rawValue: Bundle.main.object(forInfoDictionaryKey: "FDAlarmMode") as? String ?? "") ?? .localSimulation
    }

    static var telemetryDeckAppID: String? {
        let raw = Bundle.main.object(forInfoDictionaryKey: "FDTelemetryDeckAppID") as? String ?? ""
        return raw.isEmpty ? nil : raw
    }

    /// Set PRIVACY_POLICY_URL in Local.xcconfig once the policy is published (required before TestFlight).
    static var privacyPolicyURL: URL? {
        let raw = Bundle.main.object(forInfoDictionaryKey: "FDPrivacyPolicyURL") as? String ?? ""
        return raw.isEmpty ? nil : URL(string: raw)
    }

    static var isUITesting: Bool { ProcessInfo.processInfo.arguments.contains("-uiTesting") }
    static var isOfflineTesting: Bool { ProcessInfo.processInfo.arguments.contains("-offline") }
}
