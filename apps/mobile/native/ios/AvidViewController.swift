import Capacitor
import UIKit

/// The generated SceneDelegate installs this bridge controller.
final class AvidViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AvidPlaybackPlugin())
        bridge?.registerPluginInstance(AvidSystemSurfacesPlugin())
        bridge?.registerPluginInstance(AvidSessionPlugin())
        bridge?.registerPluginInstance(AvidJournalPlugin())
        bridge?.registerPluginInstance(AvidOidcPlugin())
        bridge?.registerPluginInstance(AvidAppearancePlugin())
        bridge?.registerPluginInstance(AvidAuthPlugin())
        bridge?.registerPluginInstance(AvidSpeechPlugin())
        bridge?.registerPluginInstance(AvidMediaStorePlugin())
        AvidAppearance.apply(to: self)
    }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); AvidAppearance.apply(to: self) }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle { AvidAppearance.apply(to: self) }
    }
}
