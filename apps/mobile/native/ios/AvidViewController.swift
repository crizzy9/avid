import Capacitor

/// Set the generated storyboard's bridge view controller class to AvidViewController.
final class AvidViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AvidPlaybackPlugin())
    }
}
