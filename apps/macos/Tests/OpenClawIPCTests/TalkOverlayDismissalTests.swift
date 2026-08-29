import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TalkOverlayDismissalTests {
    @Test func `a dismissal completion hides only for the transition it started for`() {
        let dismissal = UUID()

        // Nothing interrupted the fade, so the panel goes away as asked.
        #expect(
            TalkOverlayController.evaluateDismissal(current: dismissal, dismissal: dismissal)
                == .hide)

        // present() rotates the id. The completion from the fade it interrupted must not hide
        // the panel that present now owns, which is what left Talk enabled with nothing shown.
        #expect(
            TalkOverlayController.evaluateDismissal(current: UUID(), dismissal: dismissal)
                == .superseded)
    }

    @Test func `each dismissal is judged against its own transition`() {
        // present -> dismiss -> present -> dismiss, and the first completion arrives last.
        let first = UUID()
        let second = UUID()

        #expect(TalkOverlayController.evaluateDismissal(current: second, dismissal: first)
            == .superseded)
        #expect(TalkOverlayController.evaluateDismissal(current: second, dismissal: second)
            == .hide)
    }

    @Test func `a present during the dismissal fade survives the old completion`() async {
        // The reported sequence: present -> dismiss -> present -> old dismissal completion.
        // The last present must still own the panel once the interrupted fade finishes.
        let controller = TalkOverlayController()

        controller.present()
        #expect(controller.model.isVisible == true)

        controller.dismiss()
        controller.present()
        #expect(controller.model.isVisible == true)

        // Outlast the 160 ms dismissal animation so its completion has run.
        try? await Task.sleep(nanoseconds: 400_000_000)

        #expect(controller.model.isVisible == true)
    }
}
