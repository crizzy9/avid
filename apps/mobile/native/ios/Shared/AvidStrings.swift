import Foundation

/// Both the host and widget resolve the selected app language from their shared preferences.
enum AvidStrings {
    static let supported = ["en", "fi", "fr", "de", "pl", "zh-Hans", "es"]
    static var locale: String {
        let value = UserDefaults(suiteName: "group.app.avid.reader")?.string(forKey: "avid.locale")
            ?? UserDefaults.standard.string(forKey: "avid.locale") ?? "en"
        return supported.contains(value) ? value : "en"
    }
    static func text(_ key: String) -> String {
        guard let path = Bundle.main.path(forResource: locale, ofType: "lproj"), let bundle = Bundle(path: path) else { return key }
        return bundle.localizedString(forKey: key, value: key, table: "Localizable")
    }
}
