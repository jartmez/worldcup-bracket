/* sim.js — Elo win probability + Monte Carlo title odds.
 *
 * Per-match probability (standard Elo):
 *   P(A beats B) = 1 / (1 + 10^(-(Ra - Rb) / 400))
 *
 * Title odds: simulate the ENTIRE REMAINING tournament many times. Every match
 * already played is locked to its real result (read from live data, never
 * hardcoded); every unplayed match is resolved by the Elo probability of the
 * two teams that reach it in that simulation. Counting champions over N runs
 * gives each team's title %. This is a model estimate, not betting odds. */
(function (global) {
  'use strict';

  function eloProb(ra, rb) { return 1 / (1 + Math.pow(10, -((ra - rb) / 400))); }

  // Pre-flatten the tree into a bottom-up evaluation list so each run is a tight
  // loop with no recursion or allocation.
  function compile(root) {
    var order = Bracket.allNodes(root).slice().sort(function (a, b) { return b.depth - a.depth; });
    var index = {};
    order.forEach(function (n, i) { index[n.id] = i; });
    return order.map(function (n) {
      return {
        leaf: !n.children.length,
        team: n.children.length ? null : (n.team ? n.team.code : null),
        c0: n.children[0] ? index[n.children[0].id] : -1,
        c1: n.children[1] ? index[n.children[1].id] : -1,
        locked: (n.children.length && n.status === 'FINISHED' && n.winner) ? n.winner.code : null,
        isRoot: !n.parent
      };
    });
  }

  function montecarlo(root, ratings, N) {
    N = N || 20000;
    var plan = compile(root);
    var len = plan.length;
    var win = new Array(len);
    var counts = {};
    var rootSlot = -1;
    for (var s = 0; s < len; s++) if (plan[s].isRoot) rootSlot = s;

    function rate(c) { var r = ratings[c]; return r == null ? 1500 : r; }

    for (var i = 0; i < N; i++) {
      for (var j = 0; j < len; j++) {
        var m = plan[j];
        if (m.leaf) { win[j] = m.team; continue; }
        if (m.locked) { win[j] = m.locked; continue; }
        var a = win[m.c0], b = win[m.c1];
        if (a == null || b == null) { win[j] = a || b || null; continue; }
        win[j] = (Math.random() < eloProb(rate(a), rate(b))) ? a : b;
      }
      var champ = win[rootSlot];
      if (champ) counts[champ] = (counts[champ] || 0) + 1;
    }

    var odds = {};
    Object.keys(counts).forEach(function (c) { odds[c] = counts[c] / N; });
    return odds;
  }

  global.Sim = { eloProb: eloProb, montecarlo: montecarlo };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Sim;
})(typeof window !== 'undefined' ? window : globalThis);
