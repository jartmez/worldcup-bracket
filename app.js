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
  var SIM_RUNS = 20000;
  var MIN_LIQ = 20000;                // Polymarket per-team liquidity floor for match pills
  var ROUND_LABEL = { 4: 'Round of 32', 3: 'Round of 16', 2: 'Quarterfinals', 1: 'Semifinals', 0: 'Final' };
  // Per-tie derivation logs are silent by default; append ?debugTies to the URL to see them.
  var DEBUG_TIES = /[?&]debugTies\b/.test((typeof location !== 'undefined' && location.search) || '');

  var clipSeq = 0;
  var currentOdds = {};               // tla -> displayed probability (scenario in sim, baseline in live)
  var currentBaseOdds = {};           // pure Elo model: real results + Elo
  var currentScenarioOdds = {};       // real results + your picks + Elo
  var currentMarketOdds = {};         // tla -> Polymarket title probability
  var currentMarketElim = {};         // tla -> true if Polymarket resolved it out
  var currentMatchOdds = null;        // Polymarket name -> per-team stage-of-elimination data
  var marketOk = false;               // Polymarket odds available and usable
  var marketFetchedAt = null;
  var currentElim = {};               // tla -> true if the team has lost a REAL match
  var currentElimBy = {};             // tla -> team that eliminated them (real)
  var currentPickElim = {};           // tla -> true if knocked out by one of your picks
  var ELO = (window.WC_ELO && window.WC_ELO.ratings) || {};

  // ---- Simulator state ------------------------------------------------------
  var mode = 'live';                  // 'live' | 'sim'
  var picks = {};                     // nodeId -> picked team code (what-if)
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

  // ---- Data loading ---------------------------------------------------------
  function loadMatches() {
    return fetch('/api/matches', { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('proxy ' + r.status); return r.json(); })
      .then(function (d) { return { matches: d.matches || [], source: 'live' }; })
      .catch(function () {
        var snap = window.WC_SNAPSHOT || { matches: [] };
        return { matches: snap.matches || [], source: 'snapshot' };
      });
  }

  // Polymarket live title odds (functions/api/odds.js). Resolves to the parsed
  // payload or null on any failure, so the caller can fall back to Elo.
  function loadMarket() {
    return fetch('/api/odds', { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('odds ' + r.status); return r.json(); })
      .then(function (d) { if (!d || d.source !== 'polymarket' || !d.odds) throw new Error('unavailable'); return d; })
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

  // Per-team stage-of-elimination data (functions/api/match-odds.js). Resolves to
  // the teams map or null on any failure, so each tie can fall back to Elo.
  function loadMatchOdds(names) {
    if (!names.length) return Promise.resolve(null);
    return fetch('/api/match-odds?teams=' + encodeURIComponent(names.join(',')), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('match-odds ' + r.status); return r.json(); })
      .then(function (d) { return (d && d.teams) ? d.teams : null; })
      .catch(function () { return null; });
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
    if (mode !== 'live') return { ok: false, reason: 'sim mode' };
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

  // Build the real-state model, then (in sim mode) overlay valid what-if picks.
  // Reality is always locked; SimPicks.apply drops any pick contradicted by the
  // current real results or by a changed upstream pick.
  function buildModel(matches) {
    var model = Results.build(matches);
    Bracket.allNodes(model.root).forEach(function (n) {
      n.realWinner = (n.children.length && n.status === 'FINISHED') ? n.winner : null;
    });
    model.validPicks = (mode === 'sim') ? SimPicks.apply(model.root, picks) : {};
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
    currentElim = {}; currentElimBy = {}; currentPickElim = {};
    nodes.forEach(function (n) {
      if (!n.children.length || !n.winner) return;
      if (n.status === 'FINISHED') {
        [n.teamA, n.teamB].forEach(function (t) {
          if (t && t.code !== n.winner.code) { currentElim[t.code] = true; currentElimBy[t.code] = n.winner; }
        });
      } else if (n.pick) {
        // Knocked out by one of the user's what-if picks.
        [n.teamA, n.teamB].forEach(function (t) { if (t && t.code !== n.winner.code) currentPickElim[t.code] = true; });
      }
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
      var cls = 'connector' + (n.isWinnerEdge ? ' win' : '') + (n.isPickEdge ? ' pick' : '');
      gConn.appendChild(el('path', { d: Bracket.connectorPath(n), class: cls }));
    });

    // Outer ring: 32 R32 slots, ghosted once their match is decided (real or pick).
    Bracket.leaves(root).forEach(function (leaf, i) {
      var m = leaf.parent;
      var decided = !!(m && m.winner);
      var pickable = mode === 'sim' && m && m.status !== 'FINISHED' && !!leaf.team;
      gNodes.appendChild(flagNode({
        x: leaf.x, y: leaf.y, r: NODE_R, angle: leaf.angle, leafRadius: leaf.r,
        team: leaf.team, ghost: decided, code: leaf.team ? leaf.team.code : 'TBD',
        showCode: true, sub: TeamData.R32_PROVENANCE[i], tip: teamTip(leaf.team), defs: defs,
        pickable: pickable, onPick: pickable ? function () { togglePick(m, leaf.team.code); } : null
      }));
    });

    // Inner rings: decided match -> winner flag; undecided -> dot with matchup.
    nodes.forEach(function (n) {
      if (!n.children.length || n.depth === 0) return;
      if (n.winner) {
        var advanced = n.parent && n.parent.winner && n.parent.winner.code === n.winner.code;
        var pm = n.parent;
        var pickable = mode === 'sim' && pm && pm.status !== 'FINISHED' && pm.teamA && pm.teamB;
        gNodes.appendChild(flagNode({
          x: n.x, y: n.y, r: INNER_R, angle: n.angle, leafRadius: n.r,
          team: n.winner, ghost: advanced, code: n.winner.code, showCode: false,
          tip: teamTip(n.winner), defs: defs, pick: n.pick,
          pickable: pickable, onPick: pickable ? (function (mm, code) { return function () { togglePick(mm, code); }; })(pm, n.winner.code) : null
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
        tip: (root.pick ? 'Your pick to win: ' : 'Champion: ') + root.winner.name,
        defs: defs, champ: true, pick: root.pick
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
    updateBadges(model, source);
  }

  function flagNode(o) {
    var cls = 'team' + (o.ghost ? ' ghost' : '') + (o.pickable ? ' pickable' : '') + (o.pick ? ' picked' : '');
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
    g.appendChild(el('circle', { cx: o.x, cy: o.y, r: o.r, class: 'flag-ring' + (o.champ ? ' champ' : '') + (o.pick ? ' pick' : '') }));
    if (o.onPick) {
      g.addEventListener('click', function (ev) { ev.preventDefault(); o.onPick(); });
      g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); o.onPick(); } });
    }
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
    if (currentElim[team.code]) {
      var by = currentElimBy[team.code];
      return team.name + ' · eliminated' + (by ? ' by ' + by.name : '');
    }
    if (mode === 'sim' && currentPickElim[team.code]) return team.name + ' · out in your sim';
    if (mode === 'sim') {
      var s = currentScenarioOdds[team.code], b = currentBaseOdds[team.code] || 0;
      var sTxt = (s == null || s < 0.001) ? '<0.1%' : pct(s);
      var bTxt = (b < 0.001) ? '<0.1%' : pct(b);
      return team.name + ' · title ' + sTxt + ' (Elo ' + bTxt + ')';
    }
    if (marketOk) {
      if (currentMarketElim[team.code]) return team.name + ' · out (Polymarket)';
      var mo = currentMarketOdds[team.code];
      if (mo != null) return team.name + ' · title ' + pct(mo) + ' (Polymarket)';
      var eb = currentBaseOdds[team.code];
      return team.name + ' · title ' + ((eb == null || eb < 0.001) ? '<0.1%' : pct(eb)) + ' (Elo)';
    }
    var o = currentBaseOdds[team.code];
    if (o == null || o < 0.001) return team.name + ' · title <0.1%';
    return team.name + ' · title ' + pct(o) + ' (Elo)';
  }

  // Kickoff helpers (viewer's local timezone).
  function kickShort(iso) {
    var d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    var pa = market ? md.a : Sim.eloProb(rate(n.teamA.code), rate(n.teamB.code));
    var favA = pa >= 0.5;
    var fav = favA ? n.teamA : n.teamB;
    var favP = Math.round((favA ? pa : 1 - pa) * 100);
    var txt = fav.code + ' ' + favP + '%';
    var w = txt.length * 6.9 + 13, h = 17.5;
    var g = el('g', { class: 'mlabel' + (market ? ' market' : '') });
    g.appendChild(el('rect', { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h, rx: 6.5, class: 'mlabel-bg' }));
    var t = el('text', { x: n.x, y: n.y, class: 'mlabel-txt' });
    t.textContent = txt;
    g.appendChild(t);

    // Kickoff date + time beneath the pill.
    if (n.kickoff) {
      var k = el('text', { x: n.x, y: n.y + h / 2 + 8.5, class: 'mkick' });
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
      var padL = 8, dotR = 2.3, gap = 6, padR = 9;
      var tw = label.length * 5.6;
      var bw = padL + dotR * 2 + gap + tw + padR;
      var left = n.x - bw / 2;
      badge.appendChild(el('rect', { x: left, y: my - 7, width: bw, height: 14, rx: 7, class: 'mmark-bg' }));
      badge.appendChild(el('circle', { cx: left + padL + dotR, cy: my, r: dotR, class: 'mmark-dot' }));
      var mt = el('text', { x: left + padL + dotR * 2 + gap, y: my, class: 'mmark-txt' });
      mt.textContent = label;
      badge.appendChild(mt);
      g.appendChild(badge);
    }

    attachTip(g, matchTooltip(n, market ? pa : null));
    return g;
  }

  function matchTooltip(n, marketPa) {
    var a = n.teamA, b = n.teamB;
    var an = a ? a.code : 'TBD', bn = b ? b.code : 'TBD';
    if (n.status === 'FINISHED' && n.scoreLine) {
      var pens = /pens/.test(n.scoreLine) ? '  ·  decided on penalties' : '';
      return an + '  ' + n.scoreLine + '  ' + bn + (n.winner ? '  ➜ ' + n.winner.code + ' won' : '') + pens;
    }
    if (a && b) {
      var market = (marketPa != null);
      var pa = market ? marketPa : Sim.eloProb(rate(a.code), rate(b.code));
      var when = n.kickoff ? '  ·  ' + (isLive(n.status) ? 'LIVE now' : kickShort(n.kickoff)) : '';
      var src = market ? 'Polymarket-derived' : 'Elo model estimate';
      return an + ' ' + Math.round(pa * 100) + '%  v  ' + Math.round((1 - pa) * 100) + '% ' + bn + when + '  (' + src + ')';
    }
    return an + ' v ' + bn;
  }

  // ---- Title odds (Monte Carlo) ---------------------------------------------
  // Baseline = real results + Elo (pure model). Scenario = real results + your
  // valid picks (as certainties) + Elo for everything still open. With no picks
  // the two are identical (we reuse the baseline so they match exactly).
  function computeOdds(model) {
    if (!window.Sim) { currentBaseOdds = {}; currentScenarioOdds = {}; currentOdds = {}; return; }
    currentBaseOdds = Sim.montecarlo(model.root, ELO, SIM_RUNS);
    var vp = model.validPicks || {};
    currentScenarioOdds = (mode === 'sim' && Object.keys(vp).length)
      ? Sim.montecarlo(model.root, ELO, SIM_RUNS, vp)
      : currentBaseOdds;
    currentOdds = (mode === 'sim') ? currentScenarioOdds : currentBaseOdds;
  }

  // Displayed title probability for a team in the current mode:
  //  - Simulate: Elo scenario (real + picks + Elo), untouched by this pass.
  //  - Live + market up: Polymarket, with per-team Elo fallback for any team the
  //    market does not cover (never blank).
  //  - Live + market down: Elo baseline.
  function dispOdds(code, sim, useMarket) {
    if (sim) return currentScenarioOdds[code] || 0;
    if (useMarket) {
      if (currentMarketElim[code]) return 0;                                  // Polymarket says out
      return (currentMarketOdds[code] != null) ? currentMarketOdds[code] : (currentBaseOdds[code] || 0);
    }
    return currentBaseOdds[code] || 0;
  }

  function renderOdds() {
    var list = document.getElementById('odds-list');
    if (!list) return;
    var sim = mode === 'sim';
    var useMarket = !sim && marketOk;

    var h2 = document.querySelector('#odds-panel h2');
    if (h2) h2.textContent = sim ? 'Title odds · Sim' : 'Title odds';
    var note = document.querySelector('#odds-panel .odds-note');
    if (note) note.textContent = sim
      ? 'Gold = your picks, muted = Elo model'
      : (useMarket ? 'Polymarket live market' : 'Elo model estimate (fallback)');
    list.className = sim ? 'sim' : '';
    clear(list);

    // Candidate teams: Elo baseline keys plus any market-covered team.
    var pool = {};
    Object.keys(currentBaseOdds).forEach(function (c) { pool[c] = 1; });
    if (useMarket) Object.keys(currentMarketOdds).forEach(function (c) { pool[c] = 1; });
    if (sim) { pool = {}; Object.keys(currentScenarioOdds).forEach(function (c) { pool[c] = 1; }); }

    var ranked = Object.keys(pool)
      .filter(function (c) { return dispOdds(c, sim, useMarket) >= 0.001; })
      .sort(function (a, b) { return dispOdds(b, sim, useMarket) - dispOdds(a, sim, useMarket); })
      .slice(0, 12);

    ranked.forEach(function (code) {
      var shown = dispOdds(code, sim, useMarket);
      var ref = TeamData.FIFA[code];
      var li = document.createElement('li');

      var img = document.createElement('img');
      img.className = 'odds-flag'; img.src = ref ? TeamData.flagUrl(ref.iso) : ''; img.alt = code;
      var name = document.createElement('span'); name.className = 'odds-code'; name.textContent = code;

      var bar = document.createElement('span'); bar.className = 'odds-bar';
      var fill = document.createElement('span'); fill.className = 'odds-fill'; fill.style.width = Math.max(2, shown * 100) + '%';
      bar.appendChild(fill);
      if (sim) {
        var b = currentBaseOdds[code] || 0;
        var tick = document.createElement('span'); tick.className = 'odds-tick';
        tick.style.left = Math.max(0, Math.min(100, b * 100)) + '%';
        tick.title = 'Elo model: ' + pct(b);
        bar.appendChild(tick);
      }

      var val = document.createElement('span'); val.className = 'odds-val'; val.textContent = pct(shown);
      li.appendChild(img); li.appendChild(name); li.appendChild(bar); li.appendChild(val);

      if (sim) {
        var s = currentScenarioOdds[code] || 0, bb = currentBaseOdds[code] || 0, d = s - bb;
        var delta = document.createElement('span');
        delta.className = 'odds-delta ' + (d > 0.005 ? 'up' : (d < -0.005 ? 'down' : 'flat'));
        delta.textContent = Math.abs(d) < 0.005 ? '' : (d > 0 ? '+' : '−') + Math.round(Math.abs(d) * 100);
        li.appendChild(delta);
      }
      list.appendChild(li);
    });
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
  function attachTip(node, text) {
    node.addEventListener('mouseenter', function (ev) { showTip(text, ev); });
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', hideTip);
    node.addEventListener('focus', function () { var t = getTip(); t.textContent = text; t.hidden = false; });
    node.addEventListener('blur', hideTip);
  }
  function showTip(text, ev) { var t = getTip(); t.textContent = text; t.hidden = false; moveTip(ev); }
  function moveTip(ev) { var t = getTip(); t.style.left = (ev.clientX + 12) + 'px'; t.style.top = (ev.clientY - 28) + 'px'; }
  function hideTip() { getTip().hidden = true; }

  // ---- Simulator controls ---------------------------------------------------
  function rerender() {
    var model = buildModel(lastMatches);
    if (mode === 'sim') picks = model.validPicks; // prune orphaned picks to reality
    computeOdds(model);
    render(model, lastSource);
  }
  function togglePick(matchNode, code) {
    if (picks[matchNode.id] === code) delete picks[matchNode.id];
    else picks[matchNode.id] = code;
    rerender();
  }
  function resetPicks() { picks = {}; rerender(); }
  function setMode(m) {
    if (mode === m) return;
    mode = m;
    var bar = document.querySelector('.topbar');
    if (bar) bar.classList.toggle('sim', m === 'sim');
    var lb = document.getElementById('mode-live'), sb = document.getElementById('mode-sim');
    if (lb) { lb.classList.toggle('active', m === 'live'); lb.setAttribute('aria-selected', m === 'live'); }
    if (sb) { sb.classList.toggle('active', m === 'sim'); sb.setAttribute('aria-selected', m === 'sim'); }
    rerender();
  }
  function wireSimControls() {
    var lb = document.getElementById('mode-live'), sb = document.getElementById('mode-sim');
    if (lb) lb.addEventListener('click', function () { setMode('live'); });
    if (sb) sb.addEventListener('click', function () { setMode('sim'); });
    var rb = document.getElementById('reset-picks');
    if (rb) rb.addEventListener('click', resetPicks);
  }

  // ---- Boot + auto-refresh --------------------------------------------------
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

      // Pass 2: per-match pills for the current round's ties. Fetch each tie
      // team's stage-of-elimination data, then rerender so qualifying pills read
      // from the market. Live mode only. On any failure every pill stays on Elo.
      var names = (mode === 'live') ? qualifyingTieTeams() : [];
      loadMatchOdds(names).then(function (mo) {
        currentMatchOdds = mo;
        if (mo && DEBUG_TIES) logTies();
        rerender();
      });
    });
  }
  // ---- Share (copy link) ----------------------------------------------------
  function wireShare() {
    var btn = document.getElementById('share-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var url = location.href;
      var flash = function (msg) {
        var orig = btn.textContent;
        btn.textContent = msg; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
      };
      var fallback = function () {
        try {
          var ta = document.createElement('textarea');
          ta.value = url; ta.setAttribute('readonly', '');
          ta.style.position = 'absolute'; ta.style.left = '-9999px';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          flash('Copied!');
        } catch (e) { flash('Copy failed'); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { flash('Copied!'); }).catch(fallback);
      } else { fallback(); }
    });
  }

  function start() { wireShare(); wireSimControls(); cycle(); setInterval(cycle, REFRESH_MS); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
