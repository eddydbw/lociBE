# Loci — Exhibition Tablet Page: Build Brief for Claude Code

## Read this first

This is a **prototype to test a hypothesis**, not a product. Build in the slices
below, in order. After each slice there is a **TEST GATE**: stop, hand the tablet
to the human (Eddie), and wait for findings before continuing. Do not build ahead
of the gates. Resist polish that no experiment requires.

Working style: surgical edits over rewrites. All display copy and content lives in
**one editable `DATA` object** so iteration between tests is a text edit, not a
refactor.

---

## The hypothesis under test

> **A two-state tablet display (ambient "attract" wall + transient "reveal" of a
> fresh capture) lets a cold exhibition visitor understand, without anyone
> present, that a child's captured wondering travels to a parent — even though
> the demo compresses hours into seconds.**

Everything built must serve observing whether that's true. If a feature doesn't
help a cold visitor understand OR help Eddie observe them, it's out of scope.

## Context (do not re-derive, just use)

- **Project:** Loci — a P4C-grounded system for children 8–12. A zine grounds a
  child in a philosophical topic; a handheld "lens" camera takes them on a
  speculative prompt journey alone; the parent encounters the child's captures
  **later** via a web app. The async gap is load-bearing.
- **The exhibit compresses that gap deliberately and says so on screen.** The
  reveal must end by *settling into* the wall of past wonderings — the live
  moment and the async collection are one surface, not a contradiction.
- **Deployment target:** Samsung Galaxy Tab A9, landscape, Chrome-installed PWA,
  locked via Android screen pinning. Assessed **unattended** — no one explains it.
- **Backend exists:** Flask on Railway, SQLite. Captures reachable via the
  parent endpoint at `/parent/<device_id>` (4-second polling pattern already in
  use). A prior standalone prototype exists: `loci-exhibition-tablet.html` —
  start from it, don't rebuild from zero.

## Design system (non-negotiable tokens)

- Background cream `#FFFDF4`; card `#FFFEFB`; hairline `#E9E3D2`; ink `#2A2620`.
- Semantic colour: **amber/yellow = camera capture**, **blue = audio**,
  **coral = playback/challenge**. Never swap these roles.
- Type: Mansalva + Coming Soon (display / handwritten voice), Outfit (body).
- Register: whimsical, curious, question-first. Never corporate. "Big questions,"
  never "difficult questions."
- Child-drawn warmth over slickness. If a transition feels like a fintech
  dashboard, it's wrong.

---

## Build slices and test gates

### Slice 1 — Attract state, standing alone
The state the tablet shows ~95% of the time, and the only state the assessor may
ever see.

Build:
- Masthead (wordmark + tagline), a two-line pitch that names the compression
  honestly ("this screen speeds up a moment that normally reaches a parent
  hours later"), and a wall of past-capture cards: photo, topic chip, prompt,
  child's response, audio chip.
- Gentle ambient motion (slow breathe on cards). No autoplaying audio.
- Wall content from `DATA.captures`. Placeholder gradients until real thumbnails
  exist; `photoUrl` field switches a card to a real image.

**TEST GATE 1:** Eddie shows the static attract state to one cold person for 15
seconds, then asks *"what is this?"* Findings decide whether the pitch copy or
wall layout changes before Slice 2. Do not proceed on assumption.

### Slice 2 — Reveal state + settle
Build:
- Transient full-screen reveal: pulsing "a wondering just arrived" eyebrow,
  photo hero, "the lens asked" prompt, audio player (coral play button, blue
  waveform), handwritten transcript, and a foot-line naming the time
  compression.
- Configurable hold duration (default 7s, tweakable in `DATA.config`).
- On end: reveal dissolves, and the capture **lands as the freshest card on the
  wall** with a visible land-in animation. This settle is the argument of the
  whole exhibit — make it legible, not subtle.
- Dev bar (hidden with keyboard `H`, absent when a `?show=1` query param is set):
  simulate-capture button + hold slider.

**TEST GATE 2:** Trigger a reveal while a cold person is mid-look. Watch, don't
narrate. Did they connect "a child just made this" → "it joins the collection"?
Where did their eyes go? Findings feed copy/timing edits, then Slice 3.

### Slice 3 — Live wiring
Build:
- Replace simulate with polling: every 4s fetch latest capture for the device
  from the Flask app (same-origin route, e.g. `/exhibit/<device_id>` page +
  `/api/latest/<device_id>` JSON). Track seen `capture_id`s; unseen → `doReveal`.
- Queue, don't drop: if captures arrive during a reveal, reveal them in
  sequence.
- Failure honesty: if polling fails, **stay in attract silently** — never show
  an error state to a visitor. Retry with backoff. Auto-reload the page if the
  app has been idle-broken for >5 min (`location.reload()` watchdog).
- Screen wake lock (`navigator.wakeLock`), re-acquired on visibilitychange.

**TEST GATE 3:** Full loop — lens capture → reveal on tablet — with Eddie timing
the latency. If capture-to-reveal exceeds ~10s, the "just arrived" framing lies;
adjust polling or copy.

### Slice 4 — Pinnable PWA hardening (only after Gate 3 passes)
- Web manifest: `display: "fullscreen"`, `orientation: "landscape"`,
  `background_color: "#FFFDF4"`, 512px icon.
- Serve everything HTTPS from Railway. Fonts: self-host or preload — the show
  Wi-Fi is not trusted.
- Touch discipline: `touch-action: manipulation`, disable long-press context
  menus and text selection, no pull-to-refresh (`overscroll-behavior: none`).
- Nothing on screen may navigate away. No external links. The only interactive
  element a visitor should find is the audio play button (and whatever Gate 1/2
  findings added).

---

## Explicit non-goals

- No accounts, no admin panel, no CMS. `DATA` object + redeploy is the CMS.
- No analytics beyond a simple touch counter logged to console (cheap
  observation aid — optional).
- No offline service-worker complexity. If Wi-Fi dies, attract state persists
  from memory; that's enough.
- No dark mode, no responsive breakpoints beyond the A9 landscape viewport and
  one desktop fallback for development.

## Definition of done

Not "feature complete." Done is: **three cold visitors in a row can say roughly
what Loci does after 30 unattended seconds with the tablet.** Until then, the
prototype is a question, and every slice ends by asking it.
