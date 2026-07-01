/* Cloudflare Pages Function: GET /api/odds
 * Public Polymarket title odds for the tournament winner. No key, no auth.
 *
 * Fetches the "world-cup-winner" event, keeps only live team sub-markets
 * (active and not closed, with prices), reads each Yes price (title-win
 * probability), normalizes the live set to sum to 1, and returns them keyed by
 * Polymarket team name. The front end maps its bracket teams onto these names
 * and falls back to Elo for anything unresolved. Edge-cached ~60s.
 */

const WINNER_URL = 'https://gamma-api.polymarket.com/events?slug=world-cup-winner';
const CACHE_SECONDS = 60;

function yesPrice(m) {
  var p = m.outcomePrices;
  try { if (typeof p === 'string') p = JSON.parse(p); return p ? parseFloat(p[0]) : null; }
  catch (e) { return null; }
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).toString(), context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let events;
  try {
    const upstream = await fetch(WINNER_URL, { headers: { Accept: 'application/json' } });
    if (!upstream.ok) return unavailable(502);
    events = await upstream.json();
  } catch (e) {
    return unavailable(502);
  }

  const ev = Array.isArray(events) ? events[0] : events;
  const markets = (ev && ev.markets) || [];

  const raw = {};
  const eliminated = [];   // Polymarket names Polymarket has resolved as out
  let sum = 0;
  markets.forEach(function (m) {
    const y = yesPrice(m);
    const name = m.groupItemTitle;
    if (name == null || y == null || isNaN(y)) return;
    if (m.closed) { if (y === 0) eliminated.push(name); return; }   // resolved out
    if (!m.active) return;                                          // inactive placeholder
    raw[name] = y; sum += y;                                        // live contender
  });

  const names = Object.keys(raw);
  if (!names.length || sum <= 0) return unavailable(502);

  const odds = {};
  names.forEach(function (n) { odds[n] = raw[n] / sum; });

  const body = { source: 'polymarket', fetchedAt: new Date().toISOString(), count: names.length, odds: odds, eliminated: eliminated };
  const res = json(body, 200, { 'Cache-Control': 'public, max-age=' + CACHE_SECONDS });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function unavailable(status) {
  return json({ source: 'unavailable' }, status);
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
