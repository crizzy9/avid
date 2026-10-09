import AppIntents
import SwiftUI
import WidgetKit

struct AvidContinueEntry: TimelineEntry {
    let date: Date
    let book: AvidRecentBook?
}

struct AvidContinueProvider: TimelineProvider {
    func placeholder(in context: Context) -> AvidContinueEntry { AvidContinueEntry(date: Date(), book: nil) }
    func getSnapshot(in context: Context, completion: @escaping (AvidContinueEntry) -> Void) {
        completion(AvidContinueEntry(date: Date(), book: AvidSharedStore.shared.recentBooks().first))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AvidContinueEntry>) -> Void) {
        let entry = AvidContinueEntry(date: Date(), book: AvidSharedStore.shared.recentBooks().first)
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(300))))
    }
}

@available(iOS 17.0, *)
struct AvidContinueView: View {
    let entry: AvidContinueEntry
    @Environment(\.widgetFamily) var family
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("avid", systemImage: "book.closed").font(.caption).foregroundStyle(.secondary)
            if let book = entry.book {
                if let url = book.deepLink {
                    Link(destination: url) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(book.title).font(.headline).lineLimit(2)
                            if family != .accessoryRectangular { Text(book.author).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        }.privacySensitive()
                    }
                }
                if family != .accessoryRectangular { ProgressView(value: book.progress).tint(Color(red: 0.22, green: 0.39, blue: 0.37)) }
                if book.kind == "audio" {
                    if book.isPlaying {
                        Button(intent: PauseAvidAudioIntent(book: AvidBookEntity(book))) { Label("Pause", systemImage: "pause.fill") }
                    } else {
                        Button(intent: ResumeAvidAudioIntent(book: AvidBookEntity(book))) { Label("Resume", systemImage: "play.fill") }
                    }
                }
            } else {
                Text("Your next chapter awaits.").font(.headline)
                Text("Open a book in Avid to continue here.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.background, for: .widget)
    }
}

@available(iOS 17.0, *)
struct AvidContinueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: AvidSharedStore.widgetKind, provider: AvidContinueProvider()) { entry in AvidContinueView(entry: entry) }
            .configurationDisplayName("Continue with Avid")
            .description("Return to your recent book or control its audiobook.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

@available(iOS 18.0, *)
struct AvidResumeControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: AvidSharedStore.controlKind) {
            ControlWidgetButton(action: ResumeAvidAudioIntent()) { Label("Resume Avid", systemImage: "play.fill") }
        }
        .displayName("Resume Avid audio")
        .description("Resume your recent audiobook using Avid's native audio owner.")
    }
}
