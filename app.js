/* app.js — loads live knockout data, maps it onto the verified bracket tree,
 * renders the radial bracket, and overlays Elo-based model estimates.
 *
 * Advancement model: a team's flag is drawn at the deepest match-node it has
 * reached. When a match finishes, the winner's flag appears at that match node
 * (one ring inward) and positions already passed are ghosted (opacity only, so
 * it reads on any background). Connectors are computed centre-to-centre and
 * masked inside each flag circle so lines start at the rim.
 *
 * Predictions (clearly a model estimate, not betting odds):
 *  - Per-match win % from Elo: 1 / (1 + 10^(-(Ra-Rb)/400)), shown on hover.
 *  - Title odds from a Monte Carlo over the remaining tournament (played
 *    matches locked from live data), shown in a side panel and on flag hover. */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var NODE_R = 24, INNER_R = 21, CHAMP_R = 30, LABEL_GAP = 23;
  var REFRESH_MS = 60000;
  var MIN_LIQ = 20000;                // Polymarket per-team liquidity floor for match pills
  var ROUND_LABEL = { 4: 'Round of 32', 3: 'Round of 16', 2: 'Quarterfinals', 1: 'Semifinals', 0: 'Final' };
  // Per-tie derivation logs are silent by default; append ?debugTies to the URL to see them.
  var DEBUG_TIES = /[?&]debugTies\b/.test((typeof location !== 'undefined' && location.search) || '');

  // Source markers, defined once and used identically on the pills, in the hover
  // text and in the panel legend so they map. Candlestick = live market (Poly),
  // bell curve = model estimate (Elo). Distinguished by SHAPE (colourblind-safe);
  // colours are inlined so they render the same in the SVG bracket and in HTML.
  var MK_POLY_COL = '#2ee6a6', MK_ELO_COL = '#e0b04d';
  var MK_POLY = '<svg width="{s}" height="{s}" viewBox="0 0 16 16" style="vertical-align:-2px"><line x1="8" y1="2" x2="8" y2="14" stroke="' + MK_POLY_COL + '" stroke-width="1.7"/><rect x="4.3" y="5.5" width="7.4" height="6" rx="1" fill="' + MK_POLY_COL + '"/></svg>';
  var MK_ELO = '<svg width="{s}" height="{s}" viewBox="0 0 16 16" style="vertical-align:-2px"><path d="M2 13.5 C5 13.5 5 4 8 4 C11 4 11 13.5 14 13.5" fill="none" stroke="' + MK_ELO_COL + '" stroke-width="1.7" stroke-linecap="round"/></svg>';
  function markHtml(kind, px) { return (kind === 'poly' ? MK_POLY : MK_ELO).replace(/\{s\}/g, px); }
  // SVG marker element for a pill face, scaled from the 16x16 art to `size` px.
  function markerGlyph(kind, x, cy, size) {
    var g = el('g', { class: 'mk mk-' + kind, transform: 'translate(' + x + ',' + (cy - size / 2) + ') scale(' + (size / 16) + ')' });
    if (kind === 'poly') {
      g.appendChild(el('line', { x1: 8, y1: 2, x2: 8, y2: 14, class: 'mk-stroke' }));
      g.appendChild(el('rect', { x: 4.3, y: 5.5, width: 7.4, height: 6, rx: 1, class: 'mk-fill' }));
    } else {
      g.appendChild(el('path', { d: 'M2 13.5 C5 13.5 5 4 8 4 C11 4 11 13.5 14 13.5', class: 'mk-stroke', fill: 'none' }));
    }
    return g;
  }
  function fmtLiq(liq) { return liq == null ? null : '$' + Math.round(liq / 1000) + 'k'; }

  var clipSeq = 0;
  var currentOdds = {};               // tla -> displayed probability
  var currentBaseOdds = {};           // pure Elo model: real results + Elo
  var currentMarketOdds = {};         // tla -> Polymarket title probability
  var currentMarketElim = {};         // tla -> true if Polymarket resolved it out
  var currentMatchOdds = null;        // Polymarket name -> per-team stage-of-elimination data
  var liveEloBase = {};               // live Elo title odds snapshot
  var livePolyBase = {};              // live Polymarket title odds snapshot
  var marketOk = false;               // Polymarket odds available and usable
  var marketFetchedAt = null;
  var currentElim = {};               // tla -> true if the team has lost a REAL match
  var currentElimBy = {};             // tla -> team that eliminated them (real)
  var currentR32 = {};                // tla -> true if the team qualified for R32 (in any LAST_32 match)
  var ELO = (window.WC_ELO && window.WC_ELO.ratings) || {};

  // ---- Live state ------------------------------------------------------------
  var lastMatches = [];               // most recent live/snapshot matches
  var lastSource = 'snapshot';

  function el(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function rate(code) { var r = ELO[code]; return r == null ? 1500 : r; }
  function pct(p) { return (p * 100).toFixed(p >= 0.0995 ? 0 : 1) + '%'; }
  // Standard Elo win probability: 1 / (1 + 10^(-(Ra-Rb)/400)).
  function eloProb(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

  // Monte Carlo over the remaining tournament. Plays out each undecided match by
  // Elo (real results already locked in `n.realWinner`). Returns tla -> probability
  // of being champion across `runs` iterations.
  function monteCarlo(root, runs) {
    var counts = {};
    function play(node) {
      if (!node) return null;
      if (!node.children || !node.children.length) return node.team || null;
      if (node.realWinner) return node.realWinner;
      var a = play(node.children[0]);
      var b = play(node.children[1]);
      if (!a || !b) return null;
      var pa = eloProb(rate(a.code), rate(b.code));
      return Math.random() < pa ? a : b;
    }
    for (var i = 0; i < runs; i++) {
      var champ = play(root);
      if (champ) counts[champ.code] = (counts[champ.code] || 0) + 1;
    }
    var out = {};
    Object.keys(counts).forEach(function (c) { out[c] = counts[c] / runs; });
    return out;
  }

  // ---- Data loading ---------------------------------------------------------
  // Static-hosting friendly: no server-side proxy. Match data lives in
  // data/matches.json, regenerated by scripts/refresh-matches.js (locally or
  // via .github/workflows/refresh.yml). Polymarket endpoints are public and
  // CORS-friendly, so they are called directly from the browser.
  var MATCHES_URL = 'data/matches.json';
  var POLY_WINNER_URL = 'https://gamma-api.polymarket.com/events?slug=world-cup-winner';
  var POLY_STAGE_BASE = 'https://gamma-api.polymarket.com/events?slug=';

  function loadMatches() {
    return fetch(MATCHES_URL, { cache: 'no-cache', headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('matches ' + r.status); return r.json(); })
      .then(function (d) { return { matches: d.matches || [], source: 'live' }; })
      .catch(function () {
        var snap = window.WC_SNAPSHOT || { matches: [] };
        return { matches: snap.matches || [], source: 'snapshot' };
      });
  }

  // Read a Yes price from a Polymarket market. outcomePrices may arrive as a
  // JSON string or an array (we treat the first entry as the Yes side).
  function polyYesPrice(m) {
    var p = m && m.outcomePrices;
    try { if (typeof p === 'string') p = JSON.parse(p); return p ? parseFloat(p[0]) : null; }
    catch (e) { return null; }
  }

  // Polymarket live title odds. Fetches the "world-cup-winner" event directly
  // (no key, CORS-friendly), normalizes live prices to sum to 1, and returns
  // the parsed payload or null on any failure so the caller can fall back to
  // Elo.
  function loadMarket() {
    return fetch(POLY_WINNER_URL, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('odds ' + r.status); return r.json(); })
      .then(function (events) {
        var ev = Array.isArray(events) ? events[0] : events;
        if (!ev || !Array.isArray(ev.markets)) return null;
        var raw = {};
        ev.markets.forEach(function (m) {
          if (m.closed || !m.active) return;
          var y = polyYesPrice(m);
          if (y == null || isNaN(y)) return;
          var name = m.groupItemTitle || m.question || '';
          if (name) raw[name] = y;
        });
        var sum = 0; Object.keys(raw).forEach(function (k) { sum += raw[k]; });
        if (sum <= 0) return null;
        var norm = {};
        Object.keys(raw).forEach(function (k) { norm[k] = raw[k] / sum; });
        return {
          source: 'polymarket',
          fetchedAt: new Date().toISOString(),
          odds: norm,
          eliminated: ev.markets.filter(function (m) { return m.closed && m.resolvedOutcome != null; })
            .map(function (m) { return m.groupItemTitle || m.question || ''; })
            .filter(Boolean)
        };
      })
      .catch(function () { return null; });
  }
  // Map Polymarket-name odds onto our FIFA team codes via the data.js name map.
  function marketByTla(oddsByName) {
    var out = {};
    Object.keys(TeamData.FIFA).forEach(function (tla) {
      var pn = TeamData.polyName(TeamData.FIFA[tla].name);
      if (oddsByName[pn] != null) out[tla] = oddsByName[pn];
    });
    return out;
  }
  // Polymarket-resolved-out names -> our FIFA team codes.
  function marketElimByTla(names) {
    var set = {}; (names || []).forEach(function (n) { set[n] = 1; });
    var out = {};
    Object.keys(TeamData.FIFA).forEach(function (tla) {
      if (set[TeamData.polyName(TeamData.FIFA[tla].name)]) out[tla] = true;
    });
    return out;
  }

  // Polymarket name for a team object, via the data.js name map.
  function polyOf(t) { var f = TeamData.FIFA[t.code]; return TeamData.polyName(f ? f.name : t.code); }

  // A tie is market-derivable only if both teams are known and it is not finished.
  // Self-adjusting: whichever round holds such ties qualifies, all others do not.
  function isDerivableTie(n) {
    return !!(n.children.length && !n.winner && n.status !== 'FINISHED' && n.teamA && n.teamB);
  }

  // Per-team stage-of-elimination data, fetched directly from Polymarket (no
  // key, CORS-friendly). For each name we GET the team-specific event and strip
  // "Other" and "Group Stage" outcomes; the remaining rounds feed marketDerive()
  // on the front end. Returns the teams map or null on any failure.
  var SLUG_OVERRIDE = { 'Congo DR': 'dr-congo' };
  function slugify(name) {
    if (SLUG_OVERRIDE[name]) return 'world-cup-' + SLUG_OVERRIDE[name] + '-stage-of-elimination';
    var s = String(name).normalize('NFD');
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x300 && c <= 0x36f) continue;
      out += s[i];
    }
    return 'world-cup-' + out.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-stage-of-elimination';
  }
  function fetchTeamMatchOdds(name) {
    var slug = slugify(name);
    return fetch(POLY_STAGE_BASE + slug, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('event ' + r.status); return r.json(); })
      .then(function (evs) {
        var ev = Array.isArray(evs) ? evs[0] : evs;
        if (!ev || !Array.isArray(ev.markets)) return null;
        var rounds = {};
        ev.markets.forEach(function (m) {
          var label = m.groupItemTitle;
          if (label == null || label === 'Other' || label === 'Group Stage') return;
          var y = polyYesPrice(m);
          if (y == null || isNaN(y)) return;
          rounds[label] = { yes: y, closed: !!m.closed };
        });
        return {
          team: name,
          liquidity: ev.liquidity != null ? Number(ev.liquidity) : null,
          volume: ev.volume != null ? Number(ev.volume) : null,
          url: 'https://polymarket.com/event/' + slug,
          rounds: rounds
        };
      })
      .catch(function () { return null; });
  }
  function loadMatchOdds(names) {
    if (!names.length) return Promise.resolve(null);
    return Promise.all(names.map(fetchTeamMatchOdds)).then(function (rs) {
      var out = {};
      rs.forEach(function (r) { if (r) out[r.team] = r; });
      return out;
    });
  }

  // Polymarket names of every team in a currently market-derivable tie (live only).
  function qualifyingTieTeams() {
    var model = buildModel(lastMatches);
    var set = {};
    Bracket.allNodes(model.root).forEach(function (n) {
      if (isDerivableTie(n)) { set[polyOf(n.teamA)] = 1; set[polyOf(n.teamB)] = 1; }
    });
    return Object.keys(set).sort();
  }

  // Derive a tie's win split from Polymarket, or report why it falls back to Elo.
  // P(A wins) = 1 - A's "eliminated at round R" Yes; normalize the pair to sum 1.
  function marketDerive(n) {
    if (!currentMatchOdds) return { ok: false, reason: 'no market data' };
    var R = ROUND_LABEL[n.depth];
    if (!R || !n.teamA || !n.teamB) return { ok: false, reason: 'unknown round or teams' };
    var pa = polyOf(n.teamA), pb = polyOf(n.teamB);
    var ea = currentMatchOdds[pa], eb = currentMatchOdds[pb];
    if (!ea) return { ok: false, reason: 'no event for ' + pa };
    if (!eb) return { ok: false, reason: 'no event for ' + pb };
    var ra = ea.rounds && ea.rounds[R], rb = eb.rounds && eb.rounds[R];
    if (!ra || !rb) return { ok: false, reason: 'missing "' + R + '" outcome' };
    if (ra.closed || rb.closed) return { ok: false, reason: '"' + R + '" closed (divergence)' };
    if ((ea.liquidity || 0) < MIN_LIQ || (eb.liquidity || 0) < MIN_LIQ) return { ok: false, reason: 'liquidity < ' + MIN_LIQ };
    var A = 1 - ra.yes, B = 1 - rb.yes, sum = A + B;
    if (sum < 0.6 || sum > 1.4) return { ok: false, reason: 'raw sum ' + sum.toFixed(3) + ' out of 0.6..1.4' };
    return { ok: true, a: A / sum, b: B / sum, rawA: A, rawB: B, sum: sum, round: R };
  }

  // First-run visibility: log each qualifying tie's raw and normalized split.
  function logTies() {
    var model = buildModel(lastMatches);
    Bracket.allNodes(model.root).forEach(function (n) {
      if (!isDerivableTie(n)) return;
      var md = marketDerive(n), tag = n.teamA.code + ' v ' + n.teamB.code;
      if (md.ok) console.log('[tie] ' + tag + ' @ ' + md.round + ' | raw A=' + md.rawA.toFixed(3) +
        ' B=' + md.rawB.toFixed(3) + ' sum=' + md.sum.toFixed(3) + ' -> ' +
        Math.round(md.a * 100) + '% / ' + Math.round(md.b * 100) + '% (Polymarket-derived)');
      else console.log('[tie] ' + tag + ' -> Elo (' + md.reason + ')');
    });
  }

  function winnerOf(n) { return n.children.length ? n.winner : n.team; }

  // Build the real-state model from the latest matches.
  function buildModel(matches) {
    var model = Results.build(matches);
    Bracket.allNodes(model.root).forEach(function (n) {
      n.realWinner = (n.children.length && n.status === 'FINISHED') ? n.winner : null;
    });
    return model;
  }

  // ---- Rendering ------------------------------------------------------------
  function render(model, source) {
    var root = model.root;
    var defs = document.getElementById('defs');
    var gConn = document.getElementById('connectors');
    var gNodes = document.getElementById('nodes');
    var gCenter = document.getElementById('center');
    clear(defs); clear(gConn); clear(gNodes); clear(gCenter);
    clipSeq = 0;

    var nodes = Bracket.allNodes(root);

    // Eliminated = a team that actually LOST a played match (distinct from an
    // alive longshot whose Monte Carlo odds merely round to zero). Also record
    // who knocked them out, for the status text.
    currentElim = {}; currentElimBy = {};
    nodes.forEach(function (n) {
      if (!n.children.length || !n.winner) return;
      if (n.status === 'FINISHED') {
        [n.teamA, n.teamB].forEach(function (t) {
          if (t && t.code !== n.winner.code) { currentElim[t.code] = true; currentElimBy[t.code] = n.winner; }
        });
      }
    });

    // R32 qualifiers = every team that appeared as home or away in a LAST_32
    // match. Teams in a player's list that never appear here are out before
    // the knockouts (didn't qualify for the bracket).
    currentR32 = {};
    lastMatches.forEach(function (m) {
      if (m.stage !== 'LAST_32') return;
      if (m.homeTeam && m.homeTeam.tla) currentR32[m.homeTeam.tla] = true;
      if (m.awayTeam && m.awayTeam.tla) currentR32[m.awayTeam.tla] = true;
    });

    // Mask: hide each connector segment inside a flag circle (geometry unchanged).
    var holes = [];
    Bracket.leaves(root).forEach(function (leaf) { holes.push({ x: leaf.x, y: leaf.y, r: NODE_R }); });
    nodes.forEach(function (n) { if (n.children.length && n.depth !== 0 && n.winner) holes.push({ x: n.x, y: n.y, r: INNER_R }); });
    if (root.winner) holes.push({ x: Bracket.CX, y: Bracket.CY, r: CHAMP_R });
    var mask = el('mask', { id: 'conn-mask', maskUnits: 'userSpaceOnUse' });
    mask.appendChild(el('rect', { x: 0, y: 0, width: 1000, height: 1000, fill: '#fff' }));
    holes.forEach(function (h) { mask.appendChild(el('circle', { cx: h.x, cy: h.y, r: h.r, fill: '#000' })); });
    defs.appendChild(mask);
    gConn.setAttribute('mask', 'url(#conn-mask)');

    nodes.forEach(function (n) {
      if (!n.parent) return;
      var cls = 'connector' + (n.isWinnerEdge ? ' win' : '');
      gConn.appendChild(el('path', { d: Bracket.connectorPath(n), class: cls }));
    });

    // Outer ring: 32 R32 slots, ghosted once their match is decided.
    Bracket.leaves(root).forEach(function (leaf, i) {
      var m = leaf.parent;
      var decided = !!(m && m.winner);
      gNodes.appendChild(flagNode({
        x: leaf.x, y: leaf.y, r: NODE_R, angle: leaf.angle, leafRadius: leaf.r,
        team: leaf.team, ghost: decided, code: leaf.team ? leaf.team.code : 'TBD',
        showCode: true, sub: TeamData.R32_PROVENANCE[i], tip: teamTip(leaf.team), defs: defs
      }));
    });

    // Inner rings: decided match -> winner flag; undecided -> dot with matchup.
    nodes.forEach(function (n) {
      if (!n.children.length || n.depth === 0) return;
      if (n.winner) {
        var advanced = n.parent && n.parent.winner && n.parent.winner.code === n.winner.code;
        gNodes.appendChild(flagNode({
          x: n.x, y: n.y, r: INNER_R, angle: n.angle, leafRadius: n.r,
          team: n.winner, ghost: advanced, code: n.winner.code, showCode: false,
          tip: teamTip(n.winner), defs: defs
        }));
      } else if (n.parent) {
        if (n.teamA && n.teamB) {
          gNodes.appendChild(matchLabel(n));   // always-visible head-to-head %
        } else {
          var dot = el('circle', { cx: n.x, cy: n.y, r: 3, class: 'matchpt' });
          attachTip(dot, matchTooltip(n));
          gNodes.appendChild(dot);
        }
      }
    });

    // Centre: champion flag if decided, else trophy.
    gCenter.appendChild(el('circle', { cx: Bracket.CX, cy: Bracket.CY, r: 34, class: 'trophy-bg' }));
    if (root.winner) {
      gCenter.appendChild(flagNode({
        x: Bracket.CX, y: Bracket.CY, r: CHAMP_R, angle: -90, leafRadius: 0,
        team: root.winner, ghost: false, code: root.winner.code, showCode: false,
        tip: 'Champion: ' + root.winner.name,
        defs: defs, champ: true
      }));
    } else {
      var trophy = el('image', {
        x: Bracket.CX - 18, y: Bracket.CY - 30, width: 36, height: 57, class: 'trophy-img'
      });
      trophy.setAttributeNS('http://www.w3.org/1999/xlink', 'href', 'trophy.svg');
      trophy.setAttribute('href', 'trophy.svg');
      gCenter.appendChild(trophy);
    }

    renderOdds();
    renderPlayers();
    updateBadges(model, source);
  }

  // Returns the single player who picked this TLA, or null. Today's data has at
  // most one owner per team; the helper exists so the call sites stay short.
  function ownersOf(tla) {
    if (!TeamData || !TeamData.PLAYERS) return null;
    for (var i = 0; i < TeamData.PLAYERS.length; i++) {
      if (TeamData.playerTlas(TeamData.PLAYERS[i]).indexOf(tla) !== -1) return TeamData.PLAYERS[i];
    }
    return null;
  }

  // Small round player-avatar badge anchored to the bottom-right corner of a
  // flag disc, sized as a fraction of the disc radius. Halo (painted first as
  // a panel-color circle) gives separation against any flag color; the avatar
  // image is clipped to a circle. On image error, swap to a tinted disc with
  // the player's initials.
  function ownerBadge(x, y, r, player, defs) {
    var br = r * 0.4;
    var cx = x + r * 0.6;
    var cy = y + r * 0.6;
    var g = el('g', { class: 'owner-badge', 'data-name': player.name });
    g.appendChild(el('circle', { cx: cx, cy: cy, r: br + 1.5, fill: 'var(--panel)' }));
    var clipId = 'oclip' + (clipSeq++);
    var clip = el('clipPath', { id: clipId });
    clip.appendChild(el('circle', { cx: cx, cy: cy, r: br }));
    defs.appendChild(clip);
    var img = el('image', {
      x: cx - br, y: cy - br, width: br * 2, height: br * 2,
      preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#' + clipId + ')'
    });
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', 'avatars/' + player.id + '.webp');
    img.setAttribute('href', 'avatars/' + player.id + '.webp');
    img.addEventListener('error', function () {
      var fb = el('g');
      fb.appendChild(el('circle', { cx: cx, cy: cy, r: br, fill: '#23262e', stroke: 'var(--line-soft)', 'stroke-width': '1' }));
      var initials = (player.name || '?').split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
      var tx = el('text', { x: cx, y: cy + br * 0.32, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        fill: 'var(--code)', 'font-size': br * 0.95, 'font-weight': '800' });
      tx.textContent = initials;
      fb.appendChild(tx);
      img.parentNode.replaceChild(fb, img);
    });
    g.appendChild(img);
    return g;
  }

  function flagNode(o) {
    var cls = 'team' + (o.ghost ? ' ghost' : '');
    var g = el('g', { class: cls, tabindex: '0', 'data-name': o.tip });
    g.appendChild(el('circle', { cx: o.x, cy: o.y, r: o.r, class: 'flag-disc' }));
    var fallback = el('text', { x: o.x, y: o.y + 4, class: 'flag-fallback' });
    fallback.textContent = o.code;
    fallback.style.opacity = (o.team && o.team.flag) ? '0' : '1';
    if (o.team && o.team.flag) {
      var clipId = 'clip' + (clipSeq++);
      var clip = el('clipPath', { id: clipId });
      clip.appendChild(el('circle', { cx: o.x, cy: o.y, r: o.r }));
      o.defs.appendChild(clip);
      var img = el('image', {
        x: o.x - o.r, y: o.y - o.r, width: o.r * 2, height: o.r * 2,
        class: 'flag-img', preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#' + clipId + ')'
      });
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', o.team.flag);
      img.setAttribute('href', o.team.flag);
      img.addEventListener('error', function () { img.style.display = 'none'; fallback.style.opacity = '1'; g.classList.add('flag-missing'); });
      g.appendChild(img);
    } else {
      g.classList.add('flag-missing');
    }
    g.appendChild(fallback);
    g.appendChild(el('circle', { cx: o.x, cy: o.y, r: o.r, class: 'flag-ring' + (o.champ ? ' champ' : '') }));
    var owner = o.team ? ownersOf(o.team.code) : null;
    if (owner) g.appendChild(ownerBadge(o.x, o.y, o.r, owner, o.defs));
    if (o.showCode) {
      var lp = Bracket.polar(o.leafRadius + o.r + LABEL_GAP, o.angle);
      var label = el('text', { x: lp.x, y: lp.y, class: 'code' });
      label.textContent = o.code;
      g.appendChild(label);
      // Group-position provenance, stacked directly beneath the code (screen-space).
      if (o.sub) {
        var sub = el('text', { x: lp.x, y: lp.y + 12, class: 'prov' });
        sub.textContent = o.sub;
        g.appendChild(sub);
      }
    }
    attachTip(g, o.tip);
    return g;
  }

  function teamTip(team) {
    if (!team) return 'To be decided';
    var owner = ownersOf(team.code);
    var ownerSuffix = owner ? ' · picked by ' + owner.name : '';
    if (currentElim[team.code]) {
      var by = currentElimBy[team.code];
      return team.name + ' · eliminated' + (by ? ' by ' + by.name : '') + ownerSuffix;
    }
    if (marketOk) {
      if (currentMarketElim[team.code]) return team.name + ' · out' + ownerSuffix;
      var mo = currentMarketOdds[team.code];
      if (mo != null) return team.name + ' · title ' + pct(mo) + ownerSuffix;
      var eb = currentBaseOdds[team.code];
      return team.name + ' · title ' + ((eb == null || eb < 0.001) ? '<0.1%' : pct(eb)) + ownerSuffix;
    }
    var o = currentBaseOdds[team.code];
    if (o == null || o < 0.001) return team.name + ' · title <0.1%' + ownerSuffix;
    return team.name + ' · title ' + pct(o) + ownerSuffix;
  }

  // Kickoff helpers (viewer's local timezone).
  // 24-hour clock in the viewer's own zone (unchanged), only the format differs.
  // getHours maps 12:xx AM to 00 and keeps 12:xx PM at 12, per the brief.
  function kickShort(iso) {
    var d = new Date(iso);
    var mon = d.toLocaleString(undefined, { month: 'short' });
    var h = d.getHours(), m = d.getMinutes();
    return mon + ' ' + d.getDate() + ', ' + (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }
  function isToday(iso) {
    var d = new Date(iso), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  function isLive(status) { return status === 'IN_PLAY' || status === 'PAUSED'; }

  // Always-visible pill at an undecided matchup: favourite + win %, a kickoff
  // line beneath, and a LIVE/TODAY marker above when relevant.
  function matchLabel(n) {
    var md = marketDerive(n);
    var market = md.ok;
    var eloA = eloProb(rate(n.teamA.code), rate(n.teamB.code));
    var pa = market ? md.a : eloA;
    var favA = pa >= 0.5;
    var fav = favA ? n.teamA : n.teamB;
    var favP = Math.round((favA ? pa : 1 - pa) * 100);
    var kind = market ? 'poly' : 'elo';
    var txt = fav.code + ' ' + favP + '%';

    // Pill = marker glyph, then favourite + %. Widened to fit the marker.
    var markerW = 12, gap = 3, pad = 8, h = 17.5;
    var textW = txt.length * 6.9;
    var contentW = markerW + gap + textW;
    var w = contentW + pad * 2;
    var contentLeft = n.x - contentW / 2;
    var g = el('g', { class: 'mlabel' + (market ? ' market' : '') });
    g.appendChild(el('rect', { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h, rx: 6.5, class: 'mlabel-bg' }));
    g.appendChild(markerGlyph(kind, contentLeft, n.y, markerW));
    var t = el('text', { x: contentLeft + markerW + gap + textW / 2, y: n.y, class: 'mlabel-txt' });
    t.textContent = txt;
    g.appendChild(t);

    // Kickoff date + time beneath the pill.
    if (n.kickoff) {
      var k = el('text', { x: n.x, y: n.y + h / 2 + 9.5, class: 'mkick' });
      k.textContent = kickShort(n.kickoff);
      g.appendChild(k);
    }

    // LIVE / TODAY marker above the pill. Laid out left-to-right (dot, gap, text)
    // so the dot never overlaps the first letter.
    var live = isLive(n.status);
    var today = n.kickoff && isToday(n.kickoff);
    if (live || today) {
      var badge = el('g', { class: 'mmark ' + (live ? 'live' : 'today') });
      var my = n.y - h / 2 - 9;
      var label = live ? 'LIVE' : 'TODAY';
      var padL = 8, dotR = 2.3, gap2 = 6, padR = 9;
      var tw = label.length * 5.6;
      var bw = padL + dotR * 2 + gap2 + tw + padR;
      var left = n.x - bw / 2;
      badge.appendChild(el('rect', { x: left, y: my - 7, width: bw, height: 14, rx: 7, class: 'mmark-bg' }));
      badge.appendChild(el('circle', { cx: left + padL + dotR, cy: my, r: dotR, class: 'mmark-dot' }));
      var mt = el('text', { x: left + padL + dotR * 2 + gap2, y: my, class: 'mmark-txt' });
      mt.textContent = label;
      badge.appendChild(mt);
      g.appendChild(badge);
    }

    // Hover text uses the legend shorthand, no losing-side %, no source words.
    if (market) {
      var favElo = Math.round((favA ? eloA : 1 - eloA) * 100);
      var ev = currentMatchOdds[polyOf(fav)] || {};
      var liq = fmtLiq(ev.liquidity);
      var tip = markHtml('poly', 13) + ' ' + favP + '% · ' + markHtml('elo', 13) + ' ' + favElo + '%' + (liq ? ' · liq ' + liq : '');
      attachTip(g, tip, true);
      // Whole pill opens the favourite's stage-of-elimination market (new tab), so
      // the liquidity figure stays a plain, non-vanishing label in the tooltip.
      if (ev.url) {
        var a = el('a', { target: '_blank', rel: 'noopener' });
        a.setAttributeNS('http://www.w3.org/1999/xlink', 'href', ev.url);
        a.setAttribute('href', ev.url);
        a.appendChild(g);
        return a;
      }
      return g;
    }
    attachTip(g, markHtml('elo', 13) + ' ' + favP + '%', true);
    return g;
  }

  function matchTooltip(n) {
    var a = n.teamA, b = n.teamB;
    var an = a ? a.code : 'TBD', bn = b ? b.code : 'TBD';
    if (n.status === 'FINISHED' && n.scoreLine) {
      var pens = /pens/.test(n.scoreLine) ? '  ·  decided on penalties' : '';
      return an + '  ' + n.scoreLine + '  ' + bn + (n.winner ? '  ➜ ' + n.winner.code + ' won' : '') + pens;
    }
    return an + ' v ' + bn;
  }

  // ---- Title odds (Monte Carlo) ---------------------------------------------
  // Baseline = real results + Elo (pure model). Single source — Live mode only.
  function computeOdds(model) {
    currentBaseOdds = monteCarlo(model.root, 20000);
    currentOdds = currentBaseOdds;
  }

  // Displayed title probability for a team:
  //  - market up: Polymarket, with per-team Elo fallback for any team the market
  //    does not cover (never blank).
  //  - market down: Elo baseline.
  function dispOdds(code, useMarket) {
    if (useMarket) {
      if (currentMarketElim[code]) return 0;                                  // Polymarket says out
      return (currentMarketOdds[code] != null) ? currentMarketOdds[code] : (currentBaseOdds[code] || 0);
    }
    return currentBaseOdds[code] || 0;
  }

  function renderOdds() {
    var host = document.getElementById('odds-tables');
    if (!host) return;

    var h2 = document.querySelector('#odds-panel h2');
    if (h2) h2.textContent = 'Title odds';

    // Capture the live baselines each render so the panel reflects current
    // odds. Poly baseline excludes teams the market resolved out.
    liveEloBase = {};
    Object.keys(currentBaseOdds).forEach(function (c) { liveEloBase[c] = currentBaseOdds[c]; });
    livePolyBase = {};
    if (marketOk) Object.keys(currentMarketOdds).forEach(function (c) {
      if (!currentMarketElim[c]) livePolyBase[c] = currentMarketOdds[c];
    });

    var order = rankCodes();
    var legend = document.getElementById('odds-legend');
    if (legend) legend.style.display = 'block';

    clear(host);
    host.appendChild(oddsTable('poly', 'Poly', order));
    host.appendChild(oddsTable('elo', 'Elo', order));
  }

  // One shared team order for both tables so their rows line up. Ranks by the
  // Poly baseline (the headline); teams without a Poly baseline sink to the Elo
  // baseline.
  function rankCodes() {
    var pool = {};
    Object.keys(liveEloBase).forEach(function (c) { pool[c] = 1; });
    Object.keys(livePolyBase).forEach(function (c) { pool[c] = 1; });
    function keyOf(c) {
      return (livePolyBase[c] != null) ? livePolyBase[c] : ((liveEloBase[c] || 0) - 1);
    }
    return Object.keys(pool)
      .filter(function (c) { return (liveEloBase[c] || livePolyBase[c] || 0) >= 0.001; })
      .sort(function (a, b) { return keyOf(b) - keyOf(a); })
      .slice(0, 11);
  }

  // Build one title-odds table: flag, team, baseline %. No delta column.
  function oddsTable(kind, label, order) {
    var base = (kind === 'poly') ? livePolyBase : liveEloBase;
    var wrap = document.createElement('div');
    wrap.className = 'otbl otbl-' + kind;
    var head = document.createElement('div');
    head.className = 'otbl-head';
    head.innerHTML = markHtml(kind, 13) + ' <b>' + label + '</b>';
    wrap.appendChild(head);
    order.forEach(function (code) {
      var ref = TeamData.FIFA[code];
      var row = document.createElement('div');
      row.className = 'otbl-row';
      var img = document.createElement('img');
      img.className = 'odds-flag'; img.src = ref ? TeamData.flagUrl(ref.iso) : ''; img.alt = code;
      var name = document.createElement('span'); name.className = 'odds-code'; name.textContent = code;
      var pc = document.createElement('span'); pc.className = 'otbl-pct';
      var bv = base[code];
      if (bv == null) { pc.textContent = '·'; pc.classList.add('none'); }
      else pc.textContent = pct(bv);
      row.appendChild(img); row.appendChild(name); row.appendChild(pc);
      wrap.appendChild(row);
    });
    return wrap;
  }

  // ---- Players panel (top-left) --------------------------------------------
  // For each player, count how many of their 7 picked teams are still alive.
  // "Alive" = not in currentElim (real) and not in currentMarketElim (Poly says
  // out). Sorted by live count descending so the leader sits on top.
  function renderPlayers() {
    var host = document.getElementById('players-list');
    if (!host || !TeamData || !TeamData.PLAYERS) return;
    var rows = TeamData.PLAYERS.map(function (p) {
      var tlas = TeamData.playerTlas(p);
      var alive = [], out = [];
      tlas.forEach(function (tla) {
        var ref = TeamData.FIFA[tla];
        var entry = { code: tla, name: ref ? ref.name : tla, iso: ref ? ref.iso : null };
        // Out = lost in knockouts OR never qualified for R32 (pre-tournament).
        if (!currentR32[tla] || currentElim[tla] || currentMarketElim[tla]) out.push(entry);
        else alive.push(entry);
      });
      function byName(a, b) { return a.name.localeCompare(b.name); }
      alive.sort(byName); out.sort(byName);
      return { player: p, alive: alive, out: out, total: tlas.length };
    });
    rows.sort(function (a, b) { return b.alive.length - a.alive.length || a.player.name.localeCompare(b.player.name); });

    clear(host);
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'player-row' + (r.alive.length === 0 ? ' zero' : '');
      row.tabIndex = 0;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', r.player.name + ' — ' + r.alive.length + ' alive, ' + r.out.length + ' out of ' + r.total);

      var av = document.createElement('img');
      av.className = 'player-avatar';
      av.src = 'avatars/' + r.player.id + '.webp';
      av.alt = r.player.name;
      av.addEventListener('error', function () {
        av.replaceWith(makeAvatarFallback(r.player));
      });

      var name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = r.player.name;

      var cnt = document.createElement('span');
      cnt.className = 'player-count' + (r.alive.length === 0 ? ' zero' : '');
      cnt.innerHTML = r.alive.length + ' <span class="player-count-total">/' + r.total + '</span>';

      row.appendChild(av);
      row.appendChild(name);
      row.appendChild(cnt);
      attachTip(row, playerTipHtml(r.player.name, r.alive, r.out), true);
      host.appendChild(row);
    });
  }

  // Build the per-player tooltip HTML: header + Alive list + Out list. Empty
  // sections are hidden so the tooltip only shows what the player has.
  function playerTipHtml(name, alive, out) {
    function rowHtml(t) {
      var flag = t.iso ? TeamData.flagUrl(t.iso) : '';
      var img = flag
        ? '<img class="ptip-flag" src="' + flag + '" alt="">'
        : '<span class="ptip-flag ptip-flag-fb">' + (t.code || '') + '</span>';
      return '<li>' + img + '<span class="ptip-name">' + t.name + '</span></li>';
    }
    var head = '<div class="ptip-head">' + name + '</div>';
    var aliveSec = alive.length
      ? '<div class="ptip-section"><div class="ptip-label">Alive · ' + alive.length + '</div>' +
        '<ul class="ptip-list">' + alive.map(rowHtml).join('') + '</ul></div>'
      : '';
    var outSec = out.length
      ? '<div class="ptip-section"><div class="ptip-label out">Out · ' + out.length + '</div>' +
        '<ul class="ptip-list">' + out.map(rowHtml).join('') + '</ul></div>'
      : '';
    var empty = (!alive.length && !out.length) ? '<div class="ptip-empty">No teams</div>' : '';
    return '<div class="ptip">' + head + aliveSec + outSec + empty + '</div>';
  }
  function makeAvatarFallback(player) {
    var initials = (player.name || '?').split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    var d = document.createElement('div');
    d.className = 'player-avatar player-avatar-fallback';
    d.textContent = initials;
    d.title = player.name;
    return d;
  }

  function updateBadges(model, source) {
    var isLive = source === 'live';

    // Matches played of the 31 knockout matches.
    var played = model.counts.finished, total = model.counts.total || 31;
    setBar('matches-fill', played, total);
    var mtxt = document.getElementById('matches-txt');
    if (mtxt) mtxt.textContent = played + '/' + total + ' played';

    // Teams still alive of 32 (drops as teams are eliminated).
    var alive = 32 - Object.keys(currentElim).length;
    setBar('teams-fill', alive, 32);
    var ttxt = document.getElementById('teams-txt');
    if (ttxt) ttxt.textContent = alive + '/32 teams';

    // Live-status indicator in the header (green pulse when live, amber if the
    // feed is unreachable and we're rendering the bundled snapshot).
    var wrap = document.getElementById('live-status');
    var label = document.getElementById('live-label');
    if (wrap) wrap.className = 'live-status ' + (isLive ? 'on' : 'off');
    if (wrap) wrap.title = isLive ? 'Live data, auto-updating' : 'Live feed unavailable, showing a saved snapshot';
    if (label) label.textContent = isLive ? 'LIVE' : 'OFFLINE';

    // Internal integrity check kept in the console only (not user-facing).
    var v = Bracket.verify(model.root);
    if (!v.pass || model.warnings.length) console.warn('Bracket check:', v.details, model.warnings);
  }

  function setBar(id, value, max) {
    var f = document.getElementById(id);
    if (f) f.style.width = Math.max(0, Math.min(100, (value / max) * 100)) + '%';
  }

  // ---- Tooltip --------------------------------------------------------------
  var tip = null;
  function getTip() { return tip || (tip = document.getElementById('tooltip')); }
  function attachTip(node, content, isHtml) {
    node.addEventListener('mouseenter', function (ev) { showTip(content, ev, isHtml); });
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', hideTip);
    node.addEventListener('focus', function () { var t = getTip(); setTip(t, content, isHtml); t.hidden = false; });
    node.addEventListener('blur', hideTip);
  }
  function setTip(t, content, isHtml) { if (isHtml) t.innerHTML = content; else t.textContent = content; }
  function showTip(content, ev, isHtml) { var t = getTip(); setTip(t, content, isHtml); t.hidden = false; moveTip(ev); }
  function moveTip(ev) { var t = getTip(); t.style.left = (ev.clientX + 12) + 'px'; t.style.top = (ev.clientY - 28) + 'px'; }
  function hideTip() { getTip().hidden = true; }

  // ---- Boot + auto-refresh --------------------------------------------------
  function rerender() {
    var model = buildModel(lastMatches);
    computeOdds(model);
    render(model, lastSource);
  }
  function cycle() {
    Promise.all([loadMatches(), loadMarket()]).then(function (arr) {
      var m = arr[0], mk = arr[1];
      lastMatches = m.matches; lastSource = m.source;
      if (mk) {
        currentMarketOdds = marketByTla(mk.odds);
        currentMarketElim = marketElimByTla(mk.eliminated);
        marketOk = Object.keys(currentMarketOdds).length > 0;
        marketFetchedAt = mk.fetchedAt;
      } else {
        currentMarketOdds = {}; currentMarketElim = {}; marketOk = false; marketFetchedAt = null;
      }
      rerender();

      // Pass 2: per-match pills for the current round's ties. Refetches once the
      // match-odds payload is back so the candlestick pills can light up.
      loadMatchOdds(qualifyingTieTeams()).then(function (mo) {
        currentMatchOdds = mo;
        if (mo && DEBUG_TIES) logTies();
        rerender();
      });
    });
  }

  function start() { cycle(); setInterval(cycle, REFRESH_MS); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
