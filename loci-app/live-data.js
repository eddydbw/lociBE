/* =====================================================================
   Loci — live backend adapter (lociBE only; not present in the standalone
   LociAPP demo folder, which has no server behind it).

   Fetches this device's captures from the Flask backend and reshapes them
   into the same days/routes/guides shape data.js defines, so app.js needs
   no backend-specific code at all — it only ever reads LOCI_DATA. Photo
   and audio URLs are dropped straight into each step's `asset` field:
   app.js already renders a string asset as a filled, read-only slot
   ("that is the seam a real backend drops into" — see app.js's asset
   storage comment). If the fetch fails (offline, no backend, unknown
   device) LOCI_DATA is left exactly as data.js defined it, so the static
   script is a fallback, never an error state.

   Device id: ?device=<id> in the URL, else "demo" — the id both
   DEMO_SCRIPT and the exhibit's seeded script key off in server.py.

   app.js's boot() awaits window.LOCI_LIVE_READY before it reads any
   route/guide content, so this file must be loaded before app.js and
   must always resolve (never reject / hang).
   ===================================================================== */
window.LOCI_LIVE_READY = (async () => {
  // data.js declares `const LOCI_DATA`, which — unlike `var` — never becomes a window
  // property, so `window.LOCI_DATA` alone is undefined. Same fallback app.js itself uses.
  const D = (typeof LOCI_DATA !== 'undefined') ? LOCI_DATA : window.LOCI_DATA;
  if (!D) return;

  const device = new URLSearchParams(location.search).get('device') || 'demo';

  let data;
  try {
    const res = await fetch(`/api/parent/${encodeURIComponent(device)}`, { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch (_) { return; }   // offline, unreachable, or this page opened standalone

  if (!data || !Array.isArray(data.routes)) return;
  if (data.child) D.child.name = data.child;

  // The routes/nodes list carries the guide script text (opener, moves) but not real
  // timestamps; the flat captures list does. Cross-reference by URL so each node knows
  // which real day its capture belongs to.
  const tsByUrl = new Map();
  (data.captures || []).forEach((c) => {
    if (c.photoUrl) tsByUrl.set(c.photoUrl, c.timestamp);
    if (c.audioUrl) tsByUrl.set(c.audioUrl, c.timestamp);
  });
  const pad = (n) => String(n).padStart(2, '0');
  const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayIdFor = (ts) => { const n = Number(ts); return localISO(n ? new Date(n) : new Date()); };

  // node.opener looks like: `lead-in text Ask: <b>"question"</b>`
  // node.moves entries look like:            `Ask: "question"`
  // Pull the question out as a starter's "say"; whatever lead-in text precedes it (if any)
  // becomes the "why this works" rationale.
  function parseAsk(raw) {
    let m = raw.match(/^(.*?)Ask:\s*<b>[\s"“]*(.*?)[\s"”]*<\/b>\s*$/i);
    if (m) return { lead: m[1].replace(/<[^>]+>/g, '').trim(), say: m[2].trim() };
    m = raw.match(/^Ask:\s*"(.*?)"\s*$/i);
    if (m) return { lead: '', say: m[1].trim() };
    return { lead: raw.replace(/<[^>]+>/g, '').trim(), say: '' };
  }

  const AVOID_DEFAULT = [
    'Questions {he} can answer with just "yes" or "no"',
    'Explaining the "right" answer — it closes the wondering down',
    'Praising the photo instead of exploring the idea'
  ];
  const MOVES_DEFAULT = [
    { icon: '↩', name: 'Say it back', text: 'Repeat {his} idea in your own words before responding.' },
    { icon: '?', name: 'Wonder aloud', text: 'Add your own uncertainty instead of an answer.' },
    { icon: '⇄', name: 'Test it gently', text: 'Offer a counter-example as a question, not a correction.' }
  ];
  const DEFAULT_STARTER = { say: 'Walk me through what you noticed when you picked this.',
    why: "Starts from {his} own noticing, not your judgement." };

  const dayMap = new Map();   // dayId → route[]
  const guides = {};

  data.routes.forEach((route, ri) => {
    const routeId = `r-live-${device}-${ri}`;
    const steps = [];
    const stamps = [];

    // Only steps that actually happened get rendered — a pending node just means that
    // part of the route hasn't happened yet, same as it not existing yet in the feed.
    route.nodes.forEach((node) => {
      if (node.medium === 'cam' && node.photo) {
        steps.push({ type: 'photo', prompt: node.prompt, asset: node.photo, _node: node });
        stamps.push(tsByUrl.get(node.photo));
      } else if (node.medium === 'aud' && node.audio_url) {
        steps.push({ type: 'audio', prompt: node.prompt, asset: node.audio_url, duration: node.audio || '' });
        stamps.push(tsByUrl.get(node.audio_url));
      }
    });
    if (!steps.length) return;   // route not started yet — skip it, don't render an empty card

    steps.forEach((s, i) => {
      if (s.type !== 'photo') return;
      const node = s._node;
      delete s._node;
      const guideId = `g-live-${device}-${ri}-${i}`;
      s.guideId = guideId;

      const opener = parseAsk(node.opener || '');
      const starters = [];
      if (opener.say) starters.push({ say: opener.say, why: opener.lead || DEFAULT_STARTER.why });
      (node.moves || []).forEach((raw) => {
        const p = parseAsk(raw);
        if (p.say) starters.push({ say: p.say, why: 'A gentle way to test the idea a little further.' });
      });

      const audioStep = steps[i + 1] && steps[i + 1].type === 'audio' ? steps[i + 1] : null;
      guides[guideId] = {
        title: "Talking about {child}'s photo",
        subtitle: `${route.title} · a 5-minute conversation, no expertise needed`,
        recap: {
          photoFrom: [routeId, i],
          audioFrom: audioStep ? [routeId, i + 1] : null,
          text: audioStep
            ? `{child} chose this for "${node.prompt}", then recorded:`
            : `{child} chose this for "${node.prompt}".`
        },
        before: "Listen to {his} recording together first if there is one — you're not looking for a right answer, you're wondering alongside {him}. It's fine to be stumped; say so out loud.",
        waysInIntro: "Openers that ask {him} to build an answer, not just say yes or no. Tap one to see why it works.",
        starters: starters.length ? starters : [DEFAULT_STARTER],
        moves: MOVES_DEFAULT,
        avoid: AVOID_DEFAULT
      };
    });

    const dayId = dayIdFor(stamps.find(Boolean));
    const list = dayMap.get(dayId) || [];
    list.push({ id: routeId, topic: route.title, topicTint: route.dot, topicEdge: '#4A1042',
                meta: "{child}'s route", steps });
    dayMap.set(dayId, list);
  });

  if (!dayMap.size) return;   // nothing captured yet — keep the static script as the demo fallback

  D.days = Array.from(dayMap.entries()).map(([id, routes]) => ({ id, routes }));
  D.guides = guides;
})();
