# 2026 Football World Cup Knockout Visual

Worldcup tends to bring out the builder in me and tbh I wasn't sure if I was going to continue the streak into my fourth one. The last three were during college times and such, with more free time than ever but not this one as I could barely find time for the games

But this visual that has taken over football twitter finally inspired me to get past the inertia and there it is

A radial knockout bracket for the 2026 FIFA World Cup. Thirty-two teams folding inward to a single trophy at the centre, and as results come in the surviving flags march toward the middle.

Live here: https://jartmez.github.io/worldcup-bracket/

Might be a little rusty as this is the first thing I have shipped in a while. Plz be kind and treat it as the hobby project it is instead of a polished product.

But feedback's always welcome

## What it does

- Draws the full 32-team knockout as a circular tree, with each match connecting two flags to the round inside it.
- Pulls live results, so finished matches advance the winning flag inward and dim the team that went out.
- Runs an Elo model for two things: the per-match win chance shown at each tie, and overall title odds in the side panel.
- Refreshes on its own every minute, so it tracks the tournament as it plays out.

The title odds come from a Monte Carlo simulation: it plays out the rest of the tournament many thousands of times, resolving each unplayed match by the two teams' Elo, locking in the matches already decided, and counting how often each side ends up champion. These are a model estimate, not betting odds.

## How it is built

Plain HTML, CSS and JavaScript, no framework and no build step. The one moving part on the server side is a small proxy that talks to the match-data API so the API key stays off the client. The bracket geometry is a real binary tree: every leaf traces a unique path to the root, which is checked at load so the connectors can never wire the wrong two teams together.

## Data

- Match results: football-data.org.
- Elo ratings: a snapshot from eloratings.net, baked in at build time. Results stay live; the ratings are a snapshot, so the title odds still shift as matches finish even though the underlying strength numbers are fixed.
- Flags: HatScripts circle-flags.

## Running it locally

It is a static site, so any local server works:

```
npx serve .
```

Match data lives in `data/matches.json`. The bundled file is an empty placeholder
(`{ "matches": [] }`) — to populate it from football-data.org, set the API key
and run the refresh script:

```
FOOTBALL_DATA_KEY=... node scripts/refresh-matches.js
```

The page polls `data/matches.json` every 60 seconds (`cache: 'no-cache'`), so
any update you commit to that file appears on the next poll.

## Deployment

Deploys cleanly to GitHub Pages from the `main` branch root:

1. Settings → Pages → Build from `main` / `/` (root).
2. Settings → Secrets and variables → Actions → add `FOOTBALL_DATA_KEY`.
3. The workflow at `.github/workflows/refresh.yml` runs every 15 minutes
   during match windows (11:00–23:59 UTC), updates `data/matches.json`,
   and commits the result. Trigger it manually from the Actions tab if you
   want a refresh outside the schedule.

Polymarket endpoints are public and CORS-friendly, so the title-odds and
per-match market pills call `gamma-api.polymarket.com` directly from the
browser — no proxy required.

## Notes

This is a work in progress while the tournament is on. A few visual things are still on my list. If you spot something off in the bracket logic, that is the part I care most about getting right.
