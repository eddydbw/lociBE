/* =====================================================================
   Loci — parent app demo
   data.js — ALL content lives here. Edit copy freely; layout never
   needs to change. Every `asset: null` is an empty slot the demo user
   can fill with a local file (photo or audio).

   Template placeholders available in the `copy` block:
     {child}  child's name          {label} day label      {when} time label
     {he} {him} {his}  child's pronouns (capitalised: {He} {His})
   ===================================================================== */

const LOCI_DATA = {
  child: {
    name: "Ethan",
    pronouns: { he: "he", him: "him", his: "his" }
  },

  settings: {
    scaffoldMode: "full"   // "full" | "oneMove" — switchable from Settings
  },

  // The pack the child is exploring this week — shown above the feed.
  week: {
    heading: "Aesthetics",
    subline: "{child} is exploring this week's zine"
  },

  // Days appear in the Wonders pager ONLY if listed here.
  // "today" is always rendered even when its routes array is empty.
  days: [
    {
      id: "2026-09-02", label: "Today",
      routes: [
        {
          id: "r-beauty-1",
          topic: "Beauty", zineRef: "zine spread 1",
          topicTint: "#EAF2FF", topicEdge: "#78ABFE",
          meta: "{child}'s route · finished 4:13pm",
          steps: [
            { type: "photo", prompt: "Find something with your favourite colour",
              asset: null, guideId: "g-beauty-fav" },
            { type: "audio", prompt: "What makes this your favourite?",
              asset: null, duration: "0:41" }
          ]
        }
      ]
    },
    {
      id: "2026-09-01", label: "Yesterday",
      routes: [
        {
          id: "r-art-1",
          topic: "Is it art?", zineRef: "zine spread 3",
          topicTint: "#FDEEEE", topicEdge: "#F19394",
          meta: "{child}'s route · finished 5:03pm",
          talkedAt: "yesterday evening",
          steps: [
            { type: "photo",
              prompt: "Photograph something someone made without meaning to make art",
              asset: null, guideId: "g-art-unintended" },
            { type: "photo", prompt: "Now find something made on purpose to be looked at",
              asset: null, guideId: "g-art-onpurpose" }
          ]
        }
      ]
    }
  ],

  guides: {
    "g-beauty-fav": {
      title: "Talking about {child}'s photo",
      subtitle: "Beauty · a 5-minute conversation, no expertise needed",
      recap: {
        photoFrom: ["r-beauty-1", 0],          // route id + step index → reuse that asset slot
        audioFrom: ["r-beauty-1", 1],
        text: "{child} chose this for \"find something with your favourite colour\", then recorded:"
      },
      before: "Listen to {his} recording together first. You're not looking for a right answer — you're wondering alongside {him}. It's fine to be stumped; say so out loud.",
      waysInIntro: "Openers that ask {him} to build an answer, not just say yes or no. Tap one to see why it works.",
      starters: [
        { say: "Walk me through what you noticed when you picked this.",
          why: "Starts from {his} own noticing, not your judgement. {He}'s the expert on {his} choice — this hands {him} the floor." },
        { say: "You said ‹what {he} said›. Tell me more about that.",
          blank: "‹what {he} said›",   // rendered as a highlighted fill-in chip
          why: "Picks up a claim from {his} recording and treats it seriously. Whatever {he} said, repeating {his} own words back and asking for more is the strongest move you have." },
        { say: "Would you still like it if it were painted another colour?",
          why: "A gentle thought experiment: is it the colour {he} loves, or the thing? Either answer opens a real question about what makes something beautiful to us." }
      ],
      moves: [
        { icon: "↩", name: "Say it back",
          text: "Repeat {his} idea in your own words before responding.",
          eg: "\"So you're saying the colour makes it feel fast?\"" },
        { icon: "?", name: "Wonder aloud",
          text: "Add your own uncertainty instead of an answer.",
          eg: "\"I wonder if everyone has a favourite colour, or just some people…\"" },
        { icon: "⇄", name: "Test it gently",
          text: "Offer a counter-example as a question, not a correction.",
          eg: "\"My favourite colour is green — but I don't think my green jumper is fast.\"" }
      ],
      avoid: [
        "Questions {he} can answer with just \"yes\" or \"no\"",
        "Explaining the \"real\" answer — it closes the wondering down",
        "Praising the photo instead of exploring the idea"
      ]
    },

    "g-art-unintended": {
      title: "Talking about {child}'s photo",
      subtitle: "Is it art? · a 5-minute conversation, no expertise needed",
      recap: {
        photoFrom: ["r-art-1", 0],
        audioFrom: null,                        // no recording on this step
        text: "{child} chose this for \"photograph something someone made without meaning to make art\"."
      },
      before: "This one is about intention. Somebody made the thing in {his} photo, but they weren't trying to make art. Start by asking what it is and who made it — let {him} do the describing before either of you decides anything.",
      waysInIntro: "Openers that get {him} weighing what the maker meant against the thing itself. Tap one to see why it works.",
      starters: [
        { say: "Who do you think made this, and what were they trying to do?",
          why: "Puts the maker in the picture without judging them. Once {he}'s said what they were aiming for, the gap between that and \"art\" is {his} to notice." },
        { say: "You picked ‹this thing›. What made you sure it wasn't meant as art?",
          blank: "‹this thing›",
          why: "Names {his} choice and asks for {his} reasoning. {He} already has a theory of what art needs — this gets it out loud so you can both look at it." },
        { say: "If we put it in a gallery with a little label, would it become art?",
          why: "The classic thought experiment, sized for a child. It separates the object from its setting and asks which one carries the \"art\". Philosophers still split on this — there's no answer to protect." }
      ],
      moves: [
        { icon: "↩", name: "Say it back",
          text: "Repeat {his} idea in your own words before responding.",
          eg: "\"So you're saying it only counts if they meant it?\"" },
        { icon: "?", name: "Wonder aloud",
          text: "Add your own uncertainty instead of an answer.",
          eg: "\"I wonder whether the person who made this would mind us calling it art…\"" },
        { icon: "⇄", name: "Test it gently",
          text: "Offer a counter-example as a question, not a correction.",
          eg: "\"A spider doesn't mean its web to be pretty — but I think it is. Does that count?\"" }
      ],
      avoid: [
        "Telling {him} what art \"really\" is — nobody agrees, and it ends the conversation",
        "Questions {he} can answer with just \"yes\" or \"no\"",
        "Correcting {his} choice of object — the choice is the interesting bit"
      ]
    },

    "g-art-onpurpose": {
      title: "Talking about {child}'s photo",
      subtitle: "Is it art? · a 5-minute conversation, no expertise needed",
      recap: {
        photoFrom: ["r-art-1", 1],
        audioFrom: null,
        text: "{child} chose this for \"now find something made on purpose to be looked at\"."
      },
      before: "This is the second half of a pair. {He}'s found something made to be looked at — now the question is whether that's enough to make it art. Have both photos open if you can; the contrast does half the work.",
      waysInIntro: "Openers that put {his} two photos side by side in {his} head. Tap one to see why it works.",
      starters: [
        { say: "What's the difference between this and the first thing you photographed?",
          why: "Compares {his} own two choices, so the categories come from {him}. Whatever difference {he} names — trying, prettiness, an audience — is the idea worth chasing." },
        { say: "You said this one was ‹what {he} said›. Who is it for?",
          blank: "‹what {he} said›",
          why: "Repeats {his} own description and adds one small word: \"for\". That word smuggles in the audience question — does something need a viewer to be art?" },
        { say: "Could something be made to be looked at and still not be art?",
          why: "Tests whether intention is enough. Adverts, warning signs and shop windows are all made to be looked at. If {he} says they're not art, ask what's missing." }
      ],
      moves: [
        { icon: "↩", name: "Say it back",
          text: "Repeat {his} idea in your own words before responding.",
          eg: "\"So a painting is art because someone wanted us to look at it?\"" },
        { icon: "?", name: "Wonder aloud",
          text: "Add your own uncertainty instead of an answer.",
          eg: "\"I wonder if a road sign is art. Someone made it to be looked at…\"" },
        { icon: "⇄", name: "Test it gently",
          text: "Offer a counter-example as a question, not a correction.",
          eg: "\"The first thing you photographed — could someone look at that on purpose too?\"" }
      ],
      avoid: [
        "Settling it — \"it's art if it's in a museum\" ends the wondering",
        "Asking which photo is \"better\" — it isn't a competition",
        "Questions {he} can answer with just \"yes\" or \"no\""
      ]
    }
  },

  library: {
    intro: "{child}'s zines ground each topic before the lens journey begins.",
    owned: [
      { id: "z-aesthetics", title: "Aesthetics", cover: null,
        spreads: [
          { n: 1, title: "Beauty", blurb: "What makes something beautiful — the thing, or us?" },
          { n: 2, title: "Taste", blurb: "Can someone be wrong about what they like?" },
          { n: 3, title: "Is it art?", blurb: "Does making art take trying — or just looking?" }
        ],
        territory: "This pack explores how we judge what we see: beauty, taste, and what counts as art. There are no settled answers here — philosophers have argued about all three for two and a half thousand years.",
        listenFor: [
          "Reasons that point at the object (\"it's shiny\") vs. reasons that point back at {child} (\"it reminds me of…\")",
          "Moments {he} generalises — \"everyone thinks\", \"nobody likes\"",
          "{Him} changing {his} mind mid-sentence. That's the thinking happening — don't rescue {him} from it."
        ]
      }
    ],
    browse: [
      { id: "z-knowing",  title: "Knowing & Believing", blurb: "How do we know what we know?", price: "£12", cover: null },
      { id: "z-fairness", title: "Fairness",            blurb: "Who decides what's fair?",       price: "£12", cover: null },
      { id: "z-minds",    title: "Minds & Machines",    blurb: "Can a robot want things?",       price: "£12", cover: null }
    ]
  },

  lens: {
    device: { name: "{child}'s lens", battery: 74, lastSync: "today, 4:14pm" },
    queue: { count: 0,
      note: "Captures made away from Wi-Fi wait on the lens and upload when it reconnects. Offline captures arrive as photos only — recordings stay with the moment they were made." },
    swapPrompt: "Today's swap: something round",   // optional pinned card — delete field to hide
    exchange: [
      { from: "child",  type: "photo", asset: null, time: "3:02pm" },
      { from: "parent", type: "voice", asset: null, time: "3:10pm", duration: "0:12" },
      { from: "child",  type: "voice", asset: null, time: "3:41pm", duration: "0:22" },
      { from: "parent", type: "photo", asset: null, time: "3:58pm" }
    ]
  },

  // ---- Interface copy (everything that isn't per-route content) ----
  copy: {
    nav: { wonders: "Wonders", library: "Library", lens: "Lens", settings: "Settings" },

    wonders: {
      filters: { all: "All", audio: "Voice recordings", photo: "Photos" },
      talk: "Talk about this",
      talkAgain: "Talk about this again",
      talked: "You talked about this {when}",
      endOfDay: "That's everything from {label}.",
      seeDay: "See {label} →",
      began: "This is where {child}'s wonders began.",
      emptyToday: "Nothing yet today — {child} hasn't finished a route.",
      emptyDay: "No routes from {label}.",
      noAudio: "No voice recordings on this day.",
      noPhotos: "No photos on this day.",
      filtered: "Showing {label}.",
      newer: "← {label}"
    },

    slots: {
      photo: "Tap to add {child}'s photo",
      photoSmall: "Add photo",
      cover: "Add cover",
      audio: "Tap to add {his} recording",
      lensPhoto: "Tap to add the photo",
      lensAudio: "Tap to add the memo",
      remove: "Remove",
      removeConfirm: "Remove?",
      wrongPhoto: "That's not an image — pick a photo instead.",
      wrongAudio: "That's not a recording — pick an audio file instead.",
      failed: "Sorry — that file couldn't be added.",
      badAudio: "That recording couldn't be played.",
      sessionOnly: "Saved for this session only — storage is full."
    },

    guide: {
      back: "Back",
      before: "Before you start",
      waysIn: "Ways in",
      why: "Why this works",
      keeping: "Keeping it going",
      avoid: "Easy to slip into",
      talked: "We talked about it",
      talkedAgain: "We talked about it again",
      talkedDone: "Nice — it'll show in the feed ✓",
      talkedToast: "Marked as talked about.",
      alreadyTalked: "You talked about this {when}",
      another: "Show me another way in",
      started: "We've started talking",
      startedHint: "Tap when you're a minute in — the next moves appear here."
    },

    library: {
      owned: "{child}'s zines",
      spreads: "{n} spreads",
      territory: "The territory",
      listenFor: "What to listen for",
      more: "More topics",
      coming: "Coming to the demo",
      comingToast: "This pack isn't in the demo yet."
    },

    lens: {
      strip: "{name} · {battery}% · synced {sync}",
      queueEmpty: "Nothing waiting to upload.",
      queueSome: "{count} waiting to upload.",
      fromLens: "from the lens",
      you: "you",
      sendPhoto: "Send a photo",
      voiceMemo: "Voice memo",
      preview: "This is how it'll appear on {child}'s lens",
      send: "Send",
      cancel: "Cancel",
      waitingMic: "Waiting for the microphone…",
      recordNow: "Record now",
      uploadMemo: "Upload a recording",
      recording: "Recording…",
      stop: "Stop and send",
      micDenied: "Couldn't reach the microphone — upload a recording instead.",
      sent: "Sent to {child}'s lens",
      sheetTitle: "Send to {child}'s lens",
      photoFromLens: "Photo from {child}'s lens",
      photoFromYou: "Photo you sent"
    },

    a11y: {
      play: "Play recording",
      pause: "Pause recording",
      notifications: "Notifications",
      mainNav: "Main",
      filters: "Filter captures",
      clear: "×",
      removePhoto: "Remove photo",
      confirmRemove: "Tap again to remove"
    },

    settings: {
      rows: [
        { id: "profile",  label: "Child profile",    value: "{child}" },
        { id: "notify",   label: "Notifications",    value: "" },
        { id: "lens",     label: "Connected lens",   value: "{lensName}" },
        { id: "scaffold", label: "Facilitation style", value: "" },
        { id: "privacy",  label: "Data & privacy",   value: "" },
        { id: "about",    label: "About Loci",       value: "" }
      ],
      scaffoldFull: "Full guide",
      scaffoldOne: "One step at a time",
      scaffoldHint: "Changes how much of the conversation guide shows at once.",
      footer: "Loci demo — nothing here leaves your device."
    }
  }
};
