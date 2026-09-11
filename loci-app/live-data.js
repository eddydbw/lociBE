/* =====================================================================
   Loci — live backend adapter (lociBE only; not present in the standalone
   LociAPP demo folder, which has no server behind it).

   Reshapes real backend data into the same days/routes/guides shape
   data.js defines, so app.js needs no backend-specific code at all — it
   only ever reads LOCI_DATA. A photo/audio URL dropped into a step's
   `asset` field renders as a filled, read-only slot: app.js already
   supports that ("that is the seam a real backend drops into" — see its
   asset storage comment). If a fetch fails (offline, no backend, nothing
   captured yet) LOCI_DATA is left exactly as data.js defined it, so the
   static script is a fallback, never an error state.

   Two sources, chosen by URL param:

   - ?visitor=<id> (+ optional ?device=<exhibit id>, default "demo") —
     the exhibit's wonder page (wonder.html): a visitor without a working
     physical lens picks a topic and captures a photo + a typed sentence
     from their own phone. Their own wonderings (not the whole shared
     wall) are pulled back out of /api/wonders/<device>?visitor_id=<id>
     and become one route per capture. There's no recording, so the
     guide's recap shows the typed sentence as a quote instead of a
     player (app.js's `response` / `recap.response` fields — see its
     child-quote support).

   - ?device=<id> alone (default "demo") — the physical lens flow: a
     fixed conversation script (server.py's DEMO_SCRIPT) whose cam/aud
     node pairs fill in as /api/captures arrive, read from
     /api/parent/<device>.

   Either way, the "ways in" starter questions and their rationale are
   generated from the backend's opener/moves script text via parseAsk()
   below, not hand-written — see the README caveat this was shipped with.

   app.js's boot() awaits window.LOCI_LIVE_READY before it reads any
   route/guide content, so this file must be loaded before app.js and
   must always resolve (never reject / hang).
   ===================================================================== */
window.LOCI_LIVE_READY = (async () => {
  // data.js declares `const LOCI_DATA`, which — unlike `var` — never becomes a window
  // property, so `window.LOCI_DATA` alone is undefined. Same fallback app.js itself uses.
  const D = (typeof LOCI_DATA !== 'undefined') ? LOCI_DATA : window.LOCI_DATA;
  if (!D) return;

  const params = new URLSearchParams(location.search);
  const device = params.get('device') || 'demo';
  const visitor = params.get('visitor');

  const pad = (n) => String(n).padStart(2, '0');
  const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // Accepts a number or a numeric string (captures' `timestamp` field travels as a string) —
  // Date's own string constructor would try to parse it as a date string instead, silently
  // producing "Invalid Date", so the epoch value is coerced through Number() first.
  const dayIdFor = (ms) => { const n = Number(ms); return localISO(n ? new Date(n) : new Date()); };
  const fmtTime = (d) => { let h = d.getHours(); const m = pad(d.getMinutes()); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${m}${ap}`; };

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
  function startersFrom(opener, moves) {
    const starters = [];
    const o = parseAsk(opener || '');
    if (o.say) starters.push({ say: o.say, why: o.lead || DEFAULT_STARTER.why });
    (moves || []).forEach((raw) => {
      const p = parseAsk(raw);
      if (p.say) starters.push({ say: p.say, why: 'A gentle way to test the idea a little further.' });
    });
    return starters.length ? starters : [DEFAULT_STARTER];
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

  async function getJSON(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }   // offline, unreachable, or this page opened standalone
  }

  if (visitor) await loadFromWonders(device, visitor);
  else await loadFromLensScript(device);

  /* ---- wonder-page flow: one route per typed+photographed capture ---- */
  async function loadFromWonders(device, visitorId) {
    const rows = await getJSON(`/api/wonders/${encodeURIComponent(device)}?visitor_id=${encodeURIComponent(visitorId)}&limit=60`);
    if (!Array.isArray(rows) || !rows.length) return;   // nothing captured yet — keep the static script

    // The wonder page's five topics are the same five as the lens script (server.py's
    // DEMO_SCRIPT); borrow that script's title/colour/opener/moves per topic rather than
    // writing a second copy of the same philosophical content.
    const script = await getJSON(`/api/parent/demo`);
    const byTopic = new Map();
    (script && script.routes || []).forEach((route) => {
      const cam = (route.nodes || []).find((n) => n.medium === 'cam');
      byTopic.set(route.topic, { title: route.title, dot: route.dot, cam });
    });

    const dayMap = new Map();
    const guides = {};

    // Only used if the script fetch above failed — the topic slug is still readable, just plainer.
    const titleFromSlug = (slug) => (slug || '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    rows.forEach((row) => {
      const t = byTopic.get(row.topic);
      const topicTitle = (t && t.title) || titleFromSlug(row.topic);
      const routeId = `r-wonder-${row.id}`;
      const guideId = `g-wonder-${row.id}`;
      const dayId = dayIdFor(Number(row.created_at) * 1000);

      guides[guideId] = {
        title: "Talking about {child}'s photo",
        subtitle: `${topicTitle} · a 5-minute conversation, no expertise needed`,
        recap: {
          photoFrom: [routeId, 0],
          audioFrom: null,
          response: row.response,
          text: `{child} chose this for "${row.prompt}" and wrote:`
        },
        before: "Read {his} sentence together first — you're not looking for a right answer, you're wondering alongside {him}. It's fine to be stumped; say so out loud.",
        waysInIntro: "Openers that ask {him} to build an answer, not just say yes or no. Tap one to see why it works.",
        starters: startersFrom(t && t.cam && t.cam.opener, t && t.cam && t.cam.moves),
        moves: MOVES_DEFAULT,
        avoid: AVOID_DEFAULT
      };

      const list = dayMap.get(dayId) || [];
      list.push({
        id: routeId, topic: topicTitle, topicTint: (t && t.dot) || '#F4E9F2', topicEdge: '#4A1042',
        meta: `Captured ${fmtTime(new Date(Number(row.created_at) * 1000))}`,
        steps: [{ type: 'photo', prompt: row.prompt, asset: row.photoUrl, response: row.response, guideId }]
      });
      dayMap.set(dayId, list);
    });

    if (!dayMap.size) return;
    D.days = Array.from(dayMap.entries()).map(([id, routes]) => ({ id, routes }));
    D.guides = guides;
  }

  /* ---- physical lens flow: fixed script, filled in by real captures ---- */
  async function loadFromLensScript(device) {
    const data = await getJSON(`/api/parent/${encodeURIComponent(device)}`);
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

    const dayMap = new Map();
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
          starters: startersFrom(node.opener, node.moves),
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
  }
})();
