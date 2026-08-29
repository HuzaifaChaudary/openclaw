Rendered evidence for openclaw/openclaw#127645.

Produced by TalkOverlayRenderProbe, which drives the real TalkOverlayController
through present -> dismiss -> present, waits past the 160 ms fade, then renders
the real overlay view and composites it at the panel's actual alphaValue, drawing
nothing when the panel is ordered out. That is what reaches the screen.

before/  the branch base
after/   this fix
