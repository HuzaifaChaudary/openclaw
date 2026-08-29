Real on-screen captures for openclaw/openclaw#127645.

Taken with `screencapture -l<windowNumber>`, which is scoped to the single Talk
overlay panel. All four are 880x880, the 440pt panel at 2x, so nothing else on
the display is in them.

Sequence per side: present, wait, capture; then dismiss, present, wait past the
160ms fade, capture.

before/  branch base   second frame is the panel ordered out
after/   this fix      second frame is the panel still there
