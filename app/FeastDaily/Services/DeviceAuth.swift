import Foundation
import FeastCore
import Security

/// Anonymous device identity: a random device id and secret in the Keychain, exchanged for an API token.
///
/// The identity is synchronizable, so reinstalling the app or adding a second iPhone on the same iCloud Keychain
/// keeps the same account. No name, email or other personal information is ever created or sent.
struct DeviceAuth: Sendable {
    let keychain: Keychain

    init(keychain: Keychain = Keychain()) {
        self.keychain = keychain
    }

    struct Identity: Sendable, Equatable {
        let deviceId: UUID
        let secret: String
    }

    /// Returns the stored identity, creating and storing one on first launch.
    func identity() -> Identity {
        if let raw = keychain.read(.deviceIdentity) {
            let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2, let id = UUID(uuidString: parts[0]) {
                return Identity(deviceId: id, secret: parts[1])
            }
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let identity = Identity(deviceId: UUID(), secret: Data(bytes).base64EncodedString())
        keychain.write(.deviceIdentity, "\(identity.deviceId.uuidString):\(identity.secret)")
        return identity
    }

    /// Registers (or re-registers) with the server and stores the token. Idempotent.
    func signIn(api: APIClient) async throws -> String {
        let id = identity()
        let response = try await api.register(RegisterRequestDTO(deviceId: id.deviceId, deviceSecret: id.secret))
        await api.setToken(response.token)
        return response.token
    }

    /// Forgets the local identity (used after account deletion).
    func reset() {
        keychain.delete(.deviceIdentity)
        keychain.delete(.apiToken)
    }
}
