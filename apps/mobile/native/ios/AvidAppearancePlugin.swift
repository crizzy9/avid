import Capacitor
import UIKit

@MainActor
enum AvidAppearance {
    static var theme: String { UserDefaults.standard.string(forKey: "avid.appearance") ?? "system" }
    static func apply(to controller: UIViewController) {
        let style: UIUserInterfaceStyle = theme == "dark" ? .dark : theme == "light" ? .light : .unspecified
        controller.view.window?.overrideUserInterfaceStyle = style
        controller.overrideUserInterfaceStyle = style
        let dark = style == .dark || (style == .unspecified && controller.traitCollection.userInterfaceStyle == .dark)
        let color = dark ? UIColor(red: 30/255, green: 33/255, blue: 31/255, alpha: 1) : UIColor(red: 247/255, green: 246/255, blue: 242/255, alpha: 1)
        controller.view.backgroundColor = color
        controller.view.window?.backgroundColor = color
        if let bridge = controller as? CAPBridgeViewController {
            bridge.webView?.backgroundColor = color
            bridge.webView?.scrollView.backgroundColor = color
            bridge.setStatusBarStyle(dark ? .lightContent : .darkContent)
        }
        controller.setNeedsStatusBarAppearanceUpdate()
    }
}

@objc(AvidAppearancePlugin)
public class AvidAppearancePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidAppearancePlugin"
    public let jsName = "AvidAppearance"
    public let pluginMethods = [CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise)]
    @objc func setTheme(_ call: CAPPluginCall) {
        guard let theme = call.getString("theme"), ["light", "dark", "system"].contains(theme) else { call.reject("Choose light, dark, or system appearance."); return }
        DispatchQueue.main.async {
            UserDefaults.standard.set(theme, forKey: "avid.appearance")
            guard let controller = self.bridge?.viewController else { call.reject("The native window is unavailable."); return }
            AvidAppearance.apply(to: controller)
            call.resolve()
        }
    }
}
