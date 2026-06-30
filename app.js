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
  var NODE_R = 20, INNER_R = 18, CHAMP_R = 26, LABEL_GAP = 15;
  var REFRESH_MS = 60000;
  var SIM_RUNS = 20000;

  var clipSeq = 0;
  var currentOdds = {};               // tla -> championship probability
  var currentElim = {};               // tla -> true if the team has lost a match
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
    // alive longshot whose Monte Carlo odds merely round to zero).
    currentElim = {};
    nodes.forEach(function (n) {
      if (n.children.length && n.status === 'FINISHED' && n.winner) {
        [n.teamA, n.teamB].forEach(function (t) { if (t && t.code !== n.winner.code) currentElim[t.code] = true; });
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
    Bracket.leaves(root).forEach(function (leaf) {
      var played = leaf.parent && leaf.parent.status === 'FINISHED';
      gNodes.appendChild(flagNode({
        x: leaf.x, y: leaf.y, r: NODE_R, angle: leaf.angle, leafRadius: leaf.r,
        team: leaf.team, ghost: played, code: leaf.team ? leaf.team.code : 'TBD',
        showCode: true, tip: teamTip(leaf.team), defs: defs
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
      var t = el('text', { x: Bracket.CX, y: Bracket.CY + 9, class: 'trophy' });
      t.textContent = '🏆';
      gCenter.appendChild(t);
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
    }
    attachTip(g, o.tip);
    return g;
  }

  function teamTip(team) {
    if (!team) return 'To be decided';
    if (currentElim[team.code]) return team.name + ' · eliminated';
    var o = currentOdds[team.code];
    if (o == null || o < 0.001) return team.name + ' · title <0.1%';
    return team.name + ' · title ' + pct(o);
  }

  // Small always-visible pill at an undecided matchup: favourite + win %.
  function matchLabel(n) {
    var pa = Sim.eloProb(rate(n.teamA.code), rate(n.teamB.code));
    var favA = pa >= 0.5;
    var fav = favA ? n.teamA : n.teamB;
    var favP = Math.round((favA ? pa : 1 - pa) * 100);
    var txt = fav.code + ' ' + favP + '%';
    var w = txt.length * 5.0 + 9, h = 13;
    var g = el('g', { class: 'mlabel' });
    g.appendChild(el('rect', { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h, rx: 6.5, class: 'mlabel-bg' }));
    var t = el('text', { x: n.x, y: n.y, class: 'mlabel-txt' });
    t.textContent = txt;
    g.appendChild(t);
    attachTip(g, matchTooltip(n));   // full A% v B% split + date on hover
    return g;
  }

  function matchTooltip(n) {
    var a = n.teamA, b = n.teamB;
    var an = a ? a.code : 'TBD', bn = b ? b.code : 'TBD';
    if (n.status === 'FINISHED' && n.scoreLine) {
      return an + '  ' + n.scoreLine + '  ' + bn + (n.winner ? '  ➜ ' + n.winner.code : '');
    }
    if (a && b) {
      var pa = Sim.eloProb(rate(a.code), rate(b.code));
      var when = n.kickoff ? '  ·  ' + new Date(n.kickoff).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
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
    var v = Bracket.verify(model.root);
    var geo = document.getElementById('geo-badge');
    geo.className = 'badge ' + (v.pass && !model.warnings.length ? 'ok' : 'bad');
    geo.textContent = v.pass
      ? 'Geometry ✓ ' + v.leaves + ' teams · ' + v.matches + ' matches' + (model.warnings.length ? ' · ' + model.warnings.length + ' warning(s)' : ' · routes valid')
      : 'Geometry FAILED';
    var data = document.getElementById('data-badge');
    data.className = 'badge ' + (source === 'live' ? 'ok' : 'soft');
    data.textContent = (source === 'live' ? 'Live' : 'Snapshot') + ' · ' + model.counts.finished + '/' + model.counts.total + ' played';
    if (model.warnings.length) console.warn('Bracket warnings:', model.warnings);
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
  function start() { cycle(); setInterval(cycle, REFRESH_MS); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
