/* Cloudflare Pages Function: GET /api/match-odds?teams=France,Paraguay
 * Public Polymarket per-team stage-of-elimination data. No key, no auth.
 *
 * The front end passes the Polymarket names of the teams in the current round's
 * ties (it holds the bracket and round state). For each team this fetches its
 * "world-cup-<name>-stage-of-elimination" event, strips the junk outcomes
 * "Other" and "Group Stage", and returns the remaining round outcomes with their
 * Yes price and closed flag, plus liquidity and volume. Derivation stays on the
 * front end, since that is where the bracket round lives. Edge cached ~60s. A
 * team whose fetch fails is simply omitted, so the front end fails its tie to Elo.
 */

const GAMMA = 'https://gamma-api.polymarket.com/events?slug=';
const CACHE_SECONDS = 60;

// Endpoint-specific slug overrides. The stage-of-elimination endpoint names some
// teams differently from the winner market (which the pass-1 name map is keyed
// to), so the constructed slug can miss. e.g. winner market "Congo DR" but the
// stage endpoint is world-cup-dr-congo-stage-of-elimination. Keyed by the
// Polymarket name the front end sends; value is the slug fragment after the
// "world-cup-" prefix and before "-stage-of-elimination".
const SLUG_OVERRIDE = {
  'Congo DR': 'dr-congo'
};

function yesPrice(m) {
  var p = m.outcomePrices;
  try { if (typeof p === 'string') p = JSON.parse(p); return p ? parseFloat(p[0]) : null; }
  catch (e) { return null; }
}

// Polymarket name -> slug: lowercase, strip accents (combining marks by code
// point), non-alphanumerics to hyphens. e.g. "Ivory Coast" -> "ivory-coast".
function slugify(name) {
  if (SLUG_OVERRIDE[name]) return 'world-cup-' + SLUG_OVERRIDE[name] + '-stage-of-elimination';
  var s = String(name).normalize('NFD');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0x300 && c <= 0x36f) continue;   // combining diacritics
    out += s[i];
  }
  return 'world-cup-' + out.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-stage-of-elimination';
}

async function fetchTeam(name) {
  try {
    const slug = slugify(name);
    const r = await fetch(GAMMA + slug, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const evs = await r.json();
    const ev = Array.isArray(evs) ? evs[0] : evs;
    if (!ev || !Array.isArray(ev.markets)) return null;
    const rounds = {};
    ev.markets.forEach(function (m) {
      const label = m.groupItemTitle;
      if (label == null || label === 'Other' || label === 'Group Stage') return;
      const y = yesPrice(m);
      if (y == null || isNaN(y)) return;
      rounds[label] = { yes: y, closed: !!m.closed };
    });
    return {
      team: name,
      liquidity: ev.liquidity != null ? Number(ev.liquidity) : null,
      volume: ev.volume != null ? Number(ev.volume) : null,
      // Public event page for the front end to link the liquidity figure to.
      url: 'https://polymarket.com/event/' + slug,
      rounds: rounds
    };
  } catch (e) {
    return null;
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const teams = (url.searchParams.get('teams') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  if (!teams.length) return json({ source: 'match-odds', fetchedAt: new Date().toISOString(), teams: {} }, 200);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const results = await Promise.all(teams.map(fetchTeam));
  const out = {};
  results.forEach(function (r) { if (r) out[r.team] = r; });

  const res = json({ source: 'match-odds', fetchedAt: new Date().toISOString(), teams: out }, 200,
    { 'Cache-Control': 'public, max-age=' + CACHE_SECONDS });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      extra || {}
    )
  });
}
