import Foundation
import FeastCore

enum APIError: Error, LocalizedError {
    case unauthorized
    case http(Int, String)
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Not signed in."
        case .http(let code, let body): "Server error \(code): \(body.prefix(200))"
        case .transport(let e): e.localizedDescription
        case .decoding(let e): "Unexpected server response (\(e))."
        }
    }
}

/// JSON client for the Feast Daily API. Holds the bearer token; re-registers once on a 401.
actor APIClient {
    private let baseURL: URL
    private let session: URLSession
    private let keychain: Keychain
    private var token: String?
    private var reauthenticate: (@Sendable () async throws -> String)?
    private let mono = SystemMonotonicClock()
    private let bootId = BootSession.identifier()

    init(baseURL: URL = BuildConfig.apiBaseURL, keychain: Keychain = Keychain(), timeout: TimeInterval = 15) {
        self.baseURL = baseURL
        self.keychain = keychain
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
        token = keychain.read(.apiToken)
    }

    func setReauthenticate(_ handler: @escaping @Sendable () async throws -> String) {
        reauthenticate = handler
    }

    func setToken(_ value: String?) {
        token = value
        if let value { keychain.write(.apiToken, value) } else { keychain.delete(.apiToken) }
    }

    var hasToken: Bool { token != nil }

    // MARK: Endpoints

    func register(_ body: RegisterRequestDTO) async throws -> RegisterResponseDTO {
        try await send("POST", "/api/v1/auth/register", body: body, authorized: false)
    }

    func home() async throws -> HomeStateDTO {
        try await send("GET", "/api/v1/home")
    }

    func onboarding(_ body: OnboardingRequestDTO) async throws -> HomeStateDTO {
        let r: HomeEnvelopeDTO = try await send("POST", "/api/v1/onboarding", body: body)
        return r.home
    }

    func patchSettings(_ body: SettingsPatchDTO) async throws -> HomeStateDTO {
        let r: HomeEnvelopeDTO = try await send("PATCH", "/api/v1/settings", body: body)
        return r.home
    }

    func submitSessions(_ body: SessionEnvelopeDTO) async throws -> SessionsResponseDTO {
        try await send("POST", "/api/v1/sessions", body: body)
    }

    func history(from: DayKey, to: DayKey) async throws -> HistoryDTO {
        try await send("GET", "/api/v1/history", query: ["from": from.description, "to": to.description])
    }

    func alarmToday() async throws -> AlarmDTO {
        try await send("GET", "/api/v1/alarm/today")
    }

    /// Dev only: the server returns 404 unless `DEV_REVEAL_ALARM=true`.
    func devTodayAlarm() async throws -> DevAlarmDTO {
        try await send("GET", "/api/v1/dev/today-alarm")
    }

    func registerDevice(token pushToken: String, environment: String) async throws -> HomeStateDTO {
        struct Body: Encodable { let token: String; let environment: String }
        let r: HomeEnvelopeDTO = try await send("POST", "/api/v1/devices",
                                                body: Body(token: pushToken, environment: environment))
        return r.home
    }

    func deleteAccount() async throws {
        let _: EmptyResponse = try await send("DELETE", "/api/v1/account")
    }

    // MARK: Transport

    private struct EmptyResponse: Decodable {}
    private struct NoBody: Encodable {}

    private func send<R: Decodable>(_ method: String, _ path: String, query: [String: String] = [:],
                                    authorized: Bool = true) async throws -> R {
        try await send(method, path, query: query, body: Optional<NoBody>.none, authorized: authorized)
    }

    private func send<B: Encodable, R: Decodable>(_ method: String, _ path: String, query: [String: String] = [:],
                                                  body: B?, authorized: Bool = true,
                                                  retried: Bool = false) async throws -> R {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try FeastJSON.encoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // Lets the server refine this boot's monotonic anchor on every request.
        request.setValue(bootId, forHTTPHeaderField: "X-Feast-Boot-Id")
        request.setValue(String(mono.nowMilliseconds()), forHTTPHeaderField: "X-Feast-Mono-Ms")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0

        if code == 401, authorized, !retried, let reauthenticate {
            token = try await reauthenticate()
            return try await send(method, path, query: query, body: body, authorized: authorized, retried: true)
        }
        if code == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(code) else {
            throw APIError.http(code, String(decoding: data, as: UTF8.self))
        }
        if R.self == EmptyResponse.self { return EmptyResponse() as! R }
        do {
            return try FeastJSON.decoder().decode(R.self, from: data.isEmpty ? Data("{}".utf8) : data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}
