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

  var clipSeq = 0;
  var currentOdds = {};               // tla -> championship probability
  var currentElim = {};               // tla -> true if the team has lost a match
  var currentElimBy = {};             // tla -> team that eliminated them
  var ELO = (window.WC_ELO && window.WC_ELO.ratings) || {};

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
      if (n.children.length && n.status === 'FINISHED' && n.winner) {
        [n.teamA, n.teamB].forEach(function (t) {
          if (t && t.code !== n.winner.code) { currentElim[t.code] = true; currentElimBy[t.code] = n.winner; }
        });
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
      gConn.appendChild(el('path', { d: Bracket.connectorPath(n), class: 'connector' + (n.isWinnerEdge ? ' win' : '') }));
    });

    // Outer ring: 32 R32 slots, ghosted once their match is played.
    Bracket.leaves(root).forEach(function (leaf, i) {
      var played = leaf.parent && leaf.parent.status === 'FINISHED';
      gNodes.appendChild(flagNode({
        x: leaf.x, y: leaf.y, r: NODE_R, angle: leaf.angle, leafRadius: leaf.r,
        team: leaf.team, ghost: played, code: leaf.team ? leaf.team.code : 'TBD',
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
        tip: 'Champion: ' + root.winner.name, defs: defs, champ: true
      }));
    } else {
      var trophy = el('image', {
        x: Bracket.CX - 18, y: Bracket.CY - 30, width: 36, height: 57, class: 'trophy-img'
      });
      trophy.setAttributeNS('http://www.w3.org/1999/xlink', 'href', 'trophy.svg');
      trophy.setAttribute('href', 'trophy.svg');
      gCenter.appendChild(trophy);
    }

    renderOdds(model);
    updateBadges(model, source);
  }

  function flagNode(o) {
    var g = el('g', { class: 'team' + (o.ghost ? ' ghost' : ''), tabindex: '0', 'data-name': o.tip });
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
    var o = currentOdds[team.code];
    if (o == null || o < 0.001) return team.name + ' · title <0.1%';
    return team.name + ' · title ' + pct(o);
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
    var pa = Sim.eloProb(rate(n.teamA.code), rate(n.teamB.code));
    var favA = pa >= 0.5;
    var fav = favA ? n.teamA : n.teamB;
    var favP = Math.round((favA ? pa : 1 - pa) * 100);
    var txt = fav.code + ' ' + favP + '%';
    var w = txt.length * 6.9 + 13, h = 17.5;
    var g = el('g', { class: 'mlabel' });
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

    attachTip(g, matchTooltip(n));
    return g;
  }

  function matchTooltip(n) {
    var a = n.teamA, b = n.teamB;
    var an = a ? a.code : 'TBD', bn = b ? b.code : 'TBD';
    if (n.status === 'FINISHED' && n.scoreLine) {
      var pens = /pens/.test(n.scoreLine) ? '  ·  decided on penalties' : '';
      return an + '  ' + n.scoreLine + '  ' + bn + (n.winner ? '  ➜ ' + n.winner.code + ' won' : '') + pens;
    }
    if (a && b) {
      var pa = Sim.eloProb(rate(a.code), rate(b.code));
      var when = n.kickoff ? '  ·  ' + (isLive(n.status) ? 'LIVE now' : kickShort(n.kickoff)) : '';
      return an + ' ' + Math.round(pa * 100) + '%  v  ' + Math.round((1 - pa) * 100) + '% ' + bn + when + '  (Elo model)';
    }
    return an + ' v ' + bn;
  }

  // ---- Title odds (Monte Carlo) ---------------------------------------------
  function computeOdds(model) {
    if (!window.Sim) { currentOdds = {}; return; }
    currentOdds = Sim.montecarlo(model.root, ELO, SIM_RUNS);
  }

  function renderOdds(model) {
    var list = document.getElementById('odds-list');
    if (!list) return;
    clear(list);
    var ranked = Object.keys(currentOdds).map(function (code) { return [code, currentOdds[code]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .filter(function (e) { return e[1] >= 0.001; })
      .slice(0, 12);
    var alive = {};
    Bracket.leaves(model.root).forEach(function (l) { if (l.team && !(l.parent && l.parent.status === 'FINISHED')) alive[l.team.code] = 1; });
    ranked.forEach(function (e) {
      var code = e[0], p = e[1];
      var ref = TeamData.FIFA[code];
      var li = document.createElement('li');
      var img = document.createElement('img');
      img.className = 'odds-flag';
      img.src = ref ? TeamData.flagUrl(ref.iso) : '';
      img.alt = code;
      var name = document.createElement('span'); name.className = 'odds-code'; name.textContent = code;
      var bar = document.createElement('span'); bar.className = 'odds-bar';
      var fill = document.createElement('span'); fill.className = 'odds-fill'; fill.style.width = Math.max(3, p * 100) + '%';
      bar.appendChild(fill);
      var val = document.createElement('span'); val.className = 'odds-val'; val.textContent = pct(p);
      li.appendChild(img); li.appendChild(name); li.appendChild(bar); li.appendChild(val);
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
    if (wrap) wrap.title = isLive ? 'Live data, auto-updating' : 'Live feed unavailable — showing a saved snapshot';
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

  // ---- Boot + auto-refresh --------------------------------------------------
  function cycle() {
    loadMatches().then(function (res) {
      var model = Results.build(res.matches);
      computeOdds(model);
      render(model, res.source);
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

  function start() { wireShare(); cycle(); setInterval(cycle, REFRESH_MS); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
