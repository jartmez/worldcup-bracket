// scripts/refresh-matches.js — fetch the latest knockout matches from
// football-data.org and write a slimmed JSON snapshot to data/matches.json.
//
// Reads the API key from FOOTBALL_DATA_KEY. Run locally:
//   FOOTBALL_DATA_KEY=... node scripts/refresh-matches.js
// GitHub Actions runs the same script on a cron (see .github/workflows/refresh.yml).
//
// The output shape matches what app.js already consumes via the snapshot
// fallback (window.WC_SNAPSHOT), so the page renders as soon as this file is
// served — no code changes needed when the snapshot updates.

const fs = require('node:fs');
const path = require('node:path');

const COMP = 2000; // FIFA World Cup
const KO = ['LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];
const OUT_PATH = path.resolve(__dirname, '..', 'data', 'matches.json');

function slimTeam(t) {
  return t
    ? { tla: t.tla, name: t.name, crest: t.crest }
    : { tla: null, name: null, crest: null };
}

function buildPayload(raw) {
  const matches = (raw.matches || [])
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
        penalties: (m.score && m.score.penalties) || null,
      },
    }))
    .sort(
      (a, b) =>
        KO.indexOf(a.stage) - KO.indexOf(b.stage) || a.id - b.id,
    );
  return {
    generatedAt: new Date().toISOString(),
    competition: 'FIFA World Cup 2026',
    count: matches.length,
    matches,
  };
}

async function main() {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) {
    console.error('FOOTBALL_DATA_KEY env var is required');
    process.exit(1);
  }

  let upstream;
  try {
    upstream = await fetch(
      `https://api.football-data.org/v4/competitions/${COMP}/matches`,
      { headers: { 'X-Auth-Token': key } },
    );
  } catch (e) {
    console.error('Upstream fetch failed:', e);
    process.exit(1);
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    console.error(
      `Upstream error ${upstream.status}: ${body.slice(0, 200)}`,
    );
    process.exit(1);
  }

  const data = await upstream.json();
  const payload = buildPayload(data);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');

  console.log(
    `Wrote ${payload.count} matches to ${path.relative(process.cwd(), OUT_PATH)}`,
  );
}

main();