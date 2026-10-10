import Capacitor
import Foundation

/// Registered only in the main Avid Capacitor host; widgets receive no repository bridge.
@objc(AvidLibraryStoragePlugin)
public class AvidLibraryStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidLibraryStoragePlugin"
    public let jsName = "AvidLibraryStorage"
    public let pluginMethods: [CAPPluginMethod] = ["read", "commit", "beginBlob", "appendBlob", "finishBlob", "readBlob", "cancelBlob"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let worker = DispatchQueue(label: "app.avid.library-storage", qos: .utility)
    private var storage: AvidLibraryStorage?
    private func run(_ call: CAPPluginCall, epochBound: Bool = false, _ action: @escaping (AvidLibraryStorage, [String: Any], UInt64) throws -> [String: Any]) {
        guard let request = call.options as? [String: Any] else { call.reject("Invalid native library request."); return }
        let captured = AvidLibraryStorageEpoch.shared.withValue { $0 }
        worker.async {
            do {
                if self.storage == nil { self.storage = try AvidLibraryStorage(directory: AvidLibraryStorage.defaultDirectory()) }
                guard let store = self.storage else { throw AvidLibraryStorage.Failure.storage }
                let value: [String: Any]
                if epochBound {
                    value = try AvidLibraryStorageEpoch.shared.withValue { epoch in
                        guard epoch == captured else { throw AvidLibraryStorage.Failure.invalid("The connection changed before the native file operation began.") }
                        return try action(store, request, epoch)
                    }
                } else { value = try action(store, request, captured) }
                call.resolve(value)
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func read(_ call: CAPPluginCall) { run(call) { store, request, _ in try store.read(request) } }
    @objc func commit(_ call: CAPPluginCall) { run(call) { store, request, _ in try store.commit(request) } }
    @objc func beginBlob(_ call: CAPPluginCall) { run(call, epochBound: true) { store, request, epoch in try store.beginBlob(request, epoch: epoch) } }
    @objc func appendBlob(_ call: CAPPluginCall) { run(call, epochBound: true) { store, request, epoch in try store.appendBlob(request, epoch: epoch); return [:] } }
    @objc func finishBlob(_ call: CAPPluginCall) { run(call, epochBound: true) { store, request, epoch in try store.finishBlob(request, epoch: epoch) } }
    @objc func readBlob(_ call: CAPPluginCall) { run(call) { store, request, _ in try store.readBlob(request) } }
    @objc func cancelBlob(_ call: CAPPluginCall) { run(call) { store, request, _ in try store.cancelBlob(request); return [:] } }
}
