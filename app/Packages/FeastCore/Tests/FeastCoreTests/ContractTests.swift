import Foundation
import Testing
@testable import FeastCore

/// Decodes the example payloads from server/API.md (copied into Contract/ by `make contract`), so any drift
/// between the server's documented contract and the Swift models fails here.
@Suite("API contract")
struct ContractTests {
    func load(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Contract"))
        return try Data(contentsOf: url)
    }

    @Test func home() throws {
        let h = try FeastJSON.decoder().decode(HomeStateDTO.self, from: load("home"))
        #expect(h.onboarded == true)
        #expect(h.today?.status == .safe)
        #expect(h.config.window == .standard)
    }

    @Test func history() throws {
        let h = try FeastJSON.decoder().decode(HistoryDTO.self, from: load("history"))
        #expect(h.days.count == 4)
        #expect(h.days[0].result == nil)
        #expect(h.days[0].totalSeconds == 300)
        #expect(h.days[1].result == .feast)
        #expect(h.days[1].sessions?.count == 2)
    }

    @Test func sessions() throws {
        let r = try FeastJSON.decoder().decode(SessionsResponseDTO.self, from: load("sessions"))
        #expect(r.results.allSatisfy { $0.status == .accepted })
    }

    @Test func register() throws {
        let r = try FeastJSON.decoder().decode(RegisterResponseDTO.self, from: load("register"))
        #expect(!r.token.isEmpty)
    }

    @Test func devAlarm() throws {
        let r = try FeastJSON.decoder().decode(DevAlarmDTO.self, from: load("dev_alarm"))
        #expect(r.fireAt != nil)
    }
}
