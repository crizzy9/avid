import AVFoundation
import Capacitor
import Foundation

/// Bounded utterances and real UTF-16 speech ranges. Foreground JS owns chapter traversal.
@objc(AvidSpeechPlugin)
public class AvidSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "AvidSpeechPlugin"
    public let jsName = "AvidSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private lazy var synthesizer: AVSpeechSynthesizer = {
        let value = AVSpeechSynthesizer()
        // Let speech manage its own spoken-audio session. Cancelling it must not deactivate AVPlayer's.
        value.usesApplicationAudioSession = false
        value.delegate = self
        return value
    }()
    private var activeUtterance: AVSpeechUtterance?
    private var activeID: String?
    private var startedAt: TimeInterval?

    @objc func voices(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let preferred = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first ?? "en-US")?.identifier
            let values: [[String: Any]] = AVSpeechSynthesisVoice.speechVoices().map { voice in
                ["voiceURI": voice.identifier, "name": voice.name, "lang": voice.language,
                 "localService": true, "default": voice.identifier == preferred]
            }
            call.resolve(["voices": values])
        }
    }
    @objc func speak(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), (1...128).contains((id as NSString).length),
              let text = call.getString("text"), (1...4096).contains((text as NSString).length),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("Speech needs an ID and up to 4096 UTF-16 characters."); return
        }
        let rate = call.getDouble("rate") ?? 1
        guard rate.isFinite, (0.5...2).contains(rate) else { call.reject("Choose a speech rate from 0.5 to 2."); return }
        DispatchQueue.main.async {
            let utterance = AVSpeechUtterance(string: text)
            if let voiceID = call.getString("voiceURI"), !voiceID.isEmpty {
                guard let voice = AVSpeechSynthesisVoice(identifier: voiceID) else { call.reject("The selected voice is unavailable."); return }
                utterance.voice = voice
            } else if let language = call.getString("lang"), !language.isEmpty {
                guard language.count <= 64, let voice = AVSpeechSynthesisVoice(language: language) else {
                    call.reject("The selected speech language is unavailable."); return
                }
                utterance.voice = voice
            }
            utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate)))
            // Invalidate before stopping: a late didCancel for the old utterance cannot cancel its successor.
            self.activeUtterance = nil; self.activeID = nil; self.startedAt = nil
            self.synthesizer.stopSpeaking(at: .immediate)
            self.activeUtterance = utterance; self.activeID = id
            self.synthesizer.speak(utterance)
            call.resolve()
        }
    }
    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("id"), id != self.activeID { call.resolve(); return }
            self.activeUtterance = nil; self.activeID = nil; self.startedAt = nil
            self.synthesizer.stopSpeaking(at: .immediate)
            call.resolve()
        }
    }
    private func event(_ type: String, range: NSRange? = nil, message: String? = nil) -> [String: Any]? {
        guard let id = activeID else { return nil }
        var value: [String: Any] = ["id": id, "type": type]
        if let start = startedAt { value["elapsedTime"] = max(0, ProcessInfo.processInfo.systemUptime - start) }
        if let range { value["start"] = range.location; value["end"] = range.location + range.length }
        if let message { value["message"] = message }
        return value
    }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            guard self.activeUtterance === utterance, self.startedAt == nil else { return }
            self.startedAt = ProcessInfo.processInfo.systemUptime
            if let value = self.event("start") { self.notifyListeners("speech", data: value) }
        }
    }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            guard self.activeUtterance === utterance else { return }
            let text = utterance.speechString as NSString
            let start = characterRange.location, length = characterRange.length
            guard start >= 0, length > 0, start <= text.length, length <= text.length - start else { return }
            func splitsPair(_ index: Int) -> Bool {
                guard index > 0, index < text.length else { return false }
                return (0xD800...0xDBFF).contains(text.character(at: index - 1)) && (0xDC00...0xDFFF).contains(text.character(at: index))
            }
            guard !splitsPair(start), !splitsPair(start + length) else { return }
            if let value = self.event("boundary", range: characterRange) { self.notifyListeners("speech", data: value) }
        }
    }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finish(utterance, type: "end") }
    }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finish(utterance, type: "error", message: "Speech was interrupted.") }
    }
    private func finish(_ utterance: AVSpeechUtterance, type: String, message: String? = nil) {
        guard activeUtterance === utterance, let value = event(type, message: message) else { return }
        activeUtterance = nil; activeID = nil; startedAt = nil
        notifyListeners("speech", data: value)
    }
}
