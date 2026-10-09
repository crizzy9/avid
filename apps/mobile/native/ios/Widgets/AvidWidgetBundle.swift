import SwiftUI
import WidgetKit

@main
struct AvidWidgets: WidgetBundle {
    var body: some Widget {
        AvidContinueWidget()
        if #available(iOS 18.0, *) { AvidResumeControl() }
    }
}
