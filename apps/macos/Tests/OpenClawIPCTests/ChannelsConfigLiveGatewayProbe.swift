import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

/// Drives save, reload and apply against a live Gateway with no fetch override, so the
/// snapshot that lands is one the Gateway really produced.
/// Set OPENCLAW_PROOF_GATEWAY=1 with OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN.
@Suite(.serialized)
@MainActor
struct ChannelsConfigLiveGatewayProbe {
    @Test func `an edit during a real gateway save survives the reload`() async {
        guard ProcessInfo.processInfo.environment["OPENCLAW_PROOF_GATEWAY"] == "1" else { return }

        let store = ChannelsStore(isPreview: true)
        store.configSourceKey = nil
        await store.loadConfig()
        print("PROOF load status=\(store.configStatus ?? "nil") loaded=\(store.configLoaded)")

        // A is what the save submits. B is typed while that write is in flight.
        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: true)
        print("PROOF A submitted dirty=\(store.configDirty) value=\(Self.discordEnabled(store) as Any)")

        let gate = SaveGate()
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveRemote: { root in
                // A real write to the real Gateway, then hold so an edit can land behind it.
                let data = try JSONSerialization.data(
                    withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
                guard let raw = String(data: data, encoding: .utf8) else { return }
                // The Gateway refuses a write without the hash it last handed out.
                let current: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                    method: .configGet,
                    params: nil,
                    timeoutMs: 10000)
                var params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
                if let baseHash = current.hash {
                    params["baseHash"] = AnyCodable(baseHash)
                }
                let _: ProbeWriteAck = try await GatewayConnection.shared.requestDecoded(
                    method: .configSet,
                    params: params,
                    timeoutMs: 10000)
                await gate.wait()
            }))

        let saving = Task { await store.saveConfigDraft() }
        let reachedWrite = await gate.waitUntilEntered()
        print("PROOF save reached the gateway write: \(reachedWrite)")
        #expect(reachedWrite)

        store.updateConfigValue(
            path: [.key("channels"), .key("discord"), .key("enabled")],
            value: false)
        print("PROOF B typed mid-flight value=\(Self.discordEnabled(store) as Any)")

        await gate.release()
        await saving.value
        await ConfigStore._testClearOverrides()

        print("PROOF after status=\(store.configStatus ?? "nil")")
        print("PROOF after value=\(Self.discordEnabled(store) as Any) dirty=\(store.configDirty)")

        #expect(store.configStatus == nil)
        #expect(Self.discordEnabled(store) == false)
        #expect(store.configDirty == true)
    }

    static func discordEnabled(_ store: ChannelsStore) -> Bool? {
        let channels = store.configDraft["channels"] as? [String: Any]
        let discord = channels?["discord"] as? [String: Any]
        return discord?["enabled"] as? Bool
    }
}

private struct ProbeWriteAck: Decodable {
    let hash: String?
}

private actor SaveGate {
    private var entered = false
    private var released = false
    func wait() async {
        self.entered = true
        var spins = 0
        while !self.released, spins < 1500 {
            try? await Task.sleep(nanoseconds: 10_000_000)
            spins += 1
        }
    }

    func waitUntilEntered() async -> Bool {
        var spins = 0
        while !self.entered, spins < 1500 {
            try? await Task.sleep(nanoseconds: 10_000_000)
            spins += 1
        }
        return self.entered
    }

    func release() {
        self.released = true
    }
}
