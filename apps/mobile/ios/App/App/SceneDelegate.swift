import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AvidViewController()
        window?.makeKeyAndVisible()

        connectionOptions.urlContexts.forEach { AvidOidcStore.accept($0.url); AvidSystemSurfaces.handle(url: $0.url) }
        connectionOptions.userActivities.forEach { AvidSystemSurfaces.handle(activity: $0) }
        if let shortcut = connectionOptions.shortcutItem { AvidSystemSurfaces.handle(shortcut: shortcut) }
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(AvidSystemSurfaces.handle(shortcut: shortcutItem))
    }

    func sceneDidBecomeActive(_ scene: UIScene) { AvidSystemSurfaces.refresh() }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach { AvidOidcStore.accept($0.url); AvidSystemSurfaces.handle(url: $0.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        AvidSystemSurfaces.handle(activity: userActivity)
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
