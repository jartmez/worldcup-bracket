/* Cloudflare Pages Function: GET /api/matches
 * Proxies football-data.org so the API key stays server-side (never shipped to
 * the browser). Slims the payload to the knockout rounds and caches briefly to
 * stay well under the free-tier rate limit (10 req/min).
 *
 * Set the secret in the Cloudflare dashboard (Settings -> Environment variables):
 *   FOOTBALL_DATA_KEY = <your football-data.org token>
 * For local `wrangler pages dev`, put it in .dev.vars (which is git-ignored).
 */

const COMP = 2000; // FIFA World Cup
const KO = ['LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];
const CACHE_SECONDS = 60;

function slimTeam(t) {
  return t ? { tla: t.tla, name: t.name, crest: t.crest } : { tla: null, name: null, crest: null };
}

export async function onRequestGet(context) {
  const { env } = context;
  const key = env.FOOTBALL_DATA_KEY;
  if (!key) {
    return json({ error: 'Missing FOOTBALL_DATA_KEY env var' }, 500);
  }

  // Edge cache.
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).toString(), context.request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let upstream;
  try {
    upstream = await fetch(`https://api.football-data.org/v4/competitions/${COMP}/matches`, {
      headers: { 'X-Auth-Token': key }
    });
  } catch (e) {
    return json({ error: 'Upstream fetch failed', detail: String(e) }, 502);
  }

  if (!upstream.ok) {
    return json({ error: 'Upstream error', status: upstream.status }, upstream.status === 429 ? 429 : 502);
  }

  const data = await upstream.json();
  const matches = (data.matches || [])
    .filter((m) => KO.includes(m.stage))
    .map((m) => ({
      id: m.id,
      stage: m.stage,
      status: m.status,
      utcDate: m.utcDate,
      homeTeam: slimTeam(m.homeTeam),
      awayTeam: slimTeam(m.awayTeam),
      score: {
        winner: m.score && m.score.winner,
        duration: m.score && m.score.duration,
        fullTime: m.score && m.score.fullTime,
        penalties: (m.score && m.score.penalties) || null
      }
    }))
    .sort((a, b) => KO.indexOf(a.stage) - KO.indexOf(b.stage) || a.id - b.id);

  const body = {
    generatedAt: new Date().toISOString(),
    competition: 'FIFA World Cup 2026',
    count: matches.length,
    matches
  };

  const res = json(body, 200, {
    'Cache-Control': `public, max-age=${CACHE_SECONDS}`
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      extraHeaders
    )
  });
}
