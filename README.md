# 2026 Football World Cup Knockout Visual

Worldcup tends to bring out the builder in me and tbh I wasn't sure if I was going to continue the streak into my fourth one. The last three were during college times and such, with more free time than ever but not this one as I could barely find time for the games

But this visual that has taken over football twitter finally inspired me to get past the inertia and there it is

A radial knockout bracket for the 2026 FIFA World Cup. Thirty-two teams folding inward to a single trophy at the centre, and as results come in the surviving flags march toward the middle.

Live here: https://worldcup-bracket-2e1.pages.dev

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

For live data you need a football-data.org key. Put it in a `.dev.vars` file as `FOOTBALL_DATA_KEY` and run it through `wrangler pages dev` so the proxy can read it. Without a key it falls back to a bundled snapshot of recent results, so the bracket still renders.

## Notes

This is a work in progress while the tournament is on. A few visual things are still on my list. If you spot something off in the bracket logic, that is the part I care most about getting right.
