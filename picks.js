/* picks.js — overlays user "what-if" picks on top of the real bracket state.
 *
 * Hard rule: reality is locked. A match that really finished keeps its real
 * winner and can never be overridden. A pick is honoured only for a match that
 * has NOT finished and only if the picked team is actually one of that match's
 * two current participants. Because participants are recomputed from the current
 * real results + still-valid upstream picks, any pick that reality (or a changed
 * upstream pick) has contradicted is silently dropped. This makes it structurally
 * impossible to advance or crown an already-eliminated team.
 *
 * apply() returns the map of picks that were actually applied (orphans removed),
 * so callers can prune their pick state to it. It also (re)computes winner/loser/
 * pick edge flags used for rendering. Nothing here touches geometry. */
(function (global) {
  'use strict';

  function winnerOf(n) { return n.children.length ? n.winner : n.team; }

  function apply(root, picks) {
    picks = picks || {};
    var valid = {};

    function resolve(node) {
      if (!node.children.length) return node.team || null;      // R32 slot: real team, fixed
      var a = resolve(node.children[0]);
      var b = resolve(node.children[1]);
      node.teamA = a; node.teamB = b;

      // 1) Locked real result always wins.
      if (node.realWinner) { node.winner = node.realWinner; node.pick = false; return node.realWinner; }

      // 2) A user pick, only if valid against the current participants.
      var code = picks[node.id];
      if (code && a && b && (code === a.code || code === b.code)) {
        var w = (code === a.code) ? a : b;
        node.winner = w; node.pick = true; valid[node.id] = code;
        return w;
      }

      // 3) Otherwise undecided (Elo territory / awaiting a pick).
      node.winner = null; node.pick = false;
      return null;
    }
    resolve(root);

    // Recompute edge flags: a "pick edge" is the winning edge feeding a node that
    // was decided by a pick (rendered gold/dashed vs teal for real results).
    Bracket.allNodes(root).forEach(function (n) {
      if (!n.parent) return;
      var wp = winnerOf(n.parent), wn = winnerOf(n);
      n.isWinnerEdge = !!(wp && wn && wp.code === wn.code);
      n.isLoserEdge = !!(wp && wn && wp.code !== wn.code);
      n.isPickEdge = !!(n.isWinnerEdge && n.parent.pick);
    });

    return valid;
  }

  // Serialize picks to a compact URL string: "nodeId-CODE" pairs joined by "_".
  function encode(picks) {
    var parts = Object.keys(picks).map(function (id) { return id + '-' + picks[id]; });
    return parts.join('_');
  }
  function decode(str) {
    var out = {};
    if (!str) return out;
    str.split('_').forEach(function (p) {
      var i = p.indexOf('-');
      if (i > 0) {
        var id = parseInt(p.slice(0, i), 10);
        var code = p.slice(i + 1);
        if (!isNaN(id) && /^[A-Za-z-]{2,6}$/.test(code)) out[id] = code;
      }
    });
    return out;
  }

  var api = { apply: apply, winnerOf: winnerOf, encode: encode, decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SimPicks = api;
})(typeof window !== 'undefined' ? window : globalThis);
