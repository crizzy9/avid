import Capacitor

/// The generated SceneDelegate installs this bridge controller.
final class AvidViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AvidPlaybackPlugin())
        bridge?.registerPluginInstance(AvidSystemSurfacesPlugin())
    }
}
