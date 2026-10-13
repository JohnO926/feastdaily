import Foundation
import Security

/// Small Keychain wrapper. Items live in the shared access group so the widget can read the API token.
public struct Keychain: Sendable {
    public enum Item: String, Sendable {
        /// Device identity (`device_id:secret`). Synchronizable, so it survives reinstall and follows the user's
        /// iCloud Keychain to their other iPhones.
        case deviceIdentity = "feastdaily.device-identity"
        /// API bearer token. Device-only, readable after first unlock so the widget can refresh on the lock screen.
        case apiToken = "feastdaily.api-token"

        var synchronizable: Bool { self == .deviceIdentity }
    }

    public let accessGroup: String?

    /// Reads the shared access group from Info.plist key `FDKeychainAccessGroup`.
    public static var sharedAccessGroup: String? {
        let raw = Bundle.main.object(forInfoDictionaryKey: "FDKeychainAccessGroup") as? String ?? ""
        // Unsigned simulator builds leave the prefix unexpanded; fall back to the default group.
        return raw.isEmpty || raw.hasPrefix("$(") || raw.hasPrefix(".") ? nil : raw
    }

    public init(accessGroup: String? = Keychain.sharedAccessGroup) {
        self.accessGroup = accessGroup
    }

    private func baseQuery(_ item: Item) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.valiflo.feastdaily",
            kSecAttrAccount as String: item.rawValue,
            kSecAttrSynchronizable as String: item.synchronizable ? kCFBooleanTrue! : kCFBooleanFalse!,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func read(_ item: Item) -> String? {
        var q = baseQuery(item)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public func write(_ item: Item, _ value: String) -> Bool {
        let data = Data(value.utf8)
        let q = baseQuery(item)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add.merge(attrs) { $1 }
            return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
        }
        return status == errSecSuccess
    }

    public func delete(_ item: Item) {
        SecItemDelete(baseQuery(item) as CFDictionary)
    }
}
