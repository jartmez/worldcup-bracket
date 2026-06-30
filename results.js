/* results.js — maps football-data.org knockout matches onto the verified
 * bracket tree and computes advancement.
 *
 * Correctness model:
 *  - The tree (bracket.js) is the fixed FIFA structure.
 *  - Round of 32 is SEEDED positionally: football-data returns R32 in true
 *    bracket (in-order) sequence, validated earlier against FIFA's official
 *    slot definitions (computed from group standings). So the k-th id-sorted
 *    R32 match maps onto the k-th in-order R32 node.
 *  - Deeper rounds are ATTACHED BY TEAM PAIR, not by position. football-data
 *    happens to order R16+ by FIFA match number, which is a different sequence
 *    from the tree's in-order traversal, so a positional map there would bind
 *    the wrong match to a node. Matching each node to the football-data match
 *    whose two teams equal the node's two expected teams is structure-proof.
 *  - Cross-checks: any finished deeper match whose teams match no node is
 *    reported as a warning, as is any winner not among a node's expected pair.
 */
(function (global) {
  'use strict';

  var STAGE_BY_DEPTH = { 4: 'LAST_32', 3: 'LAST_16', 2: 'QUARTER_FINALS', 1: 'SEMI_FINALS', 0: 'FINAL' };
  var DEEPER = ['LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];

  function nodesByDepth(root) {
    var by = {};
    Bracket.allNodes(root).forEach(function (n) { (by[n.depth] = by[n.depth] || []).push(n); });
    Object.keys(by).forEach(function (d) { by[d].sort(function (a, b) { return a.idx - b.idx; }); });
    return by;
  }

  function pairKey(a, b) { return [a, b].sort().join('|'); }

  function winnerTla(m) {
    if (!m || m.status !== 'FINISHED' || !m.score || !m.score.winner) return null;
    if (m.score.winner === 'HOME_TEAM') return m.homeTeam && m.homeTeam.tla;
    if (m.score.winner === 'AWAY_TEAM') return m.awayTeam && m.awayTeam.tla;
    return null;
  }

  function scoreLine(m) {
    if (!m || !m.score || !m.score.fullTime) return null;
    var ft = m.score.fullTime;
    if (ft.home == null || ft.away == null) return null;
    var line = ft.home + '-' + ft.away;
    var pens = m.score.penalties;
    if (pens && pens.home != null && pens.away != null) line += ' (' + pens.home + '-' + pens.away + ' pens)';
    return line;
  }

  function build(matches) {
    var root = Bracket.buildTree();
    var by = nodesByDepth(root);

    var stages = {};
    matches.forEach(function (m) { if (m.stage) (stages[m.stage] = stages[m.stage] || []).push(m); });
    Object.keys(stages).forEach(function (s) { stages[s].sort(function (a, b) { return a.id - b.id; }); });

    // R32: positional seed (verified bracket order). Sets leaf teams + R32 node.fd.
    (by[4] || []).forEach(function (node, k) {
      var m = (stages.LAST_32 || [])[k] || null;
      node.fd = m;
      var kids = node.children.slice().sort(function (a, b) { return a.idx - b.idx; });
      kids[0].team = m ? Data.resolveTeam(m.homeTeam) : null;
      kids[1].team = m ? Data.resolveTeam(m.awayTeam) : null;
    });

    // Deeper rounds: index by team-pair for structure-proof attachment.
    var byPair = {};
    var attached = {};
    DEEPER.forEach(function (s) {
      byPair[s] = {};
      (stages[s] || []).forEach(function (m) {
        if (m.homeTeam && m.homeTeam.tla && m.awayTeam && m.awayTeam.tla) {
          byPair[s][pairKey(m.homeTeam.tla, m.awayTeam.tla)] = m;
        }
      });
    });

    var warnings = [];

    function resolve(node) {
      if (!node.children.length) return node.team || null;
      var a = resolve(node.children[0]);
      var b = resolve(node.children[1]);
      node.teamA = a; node.teamB = b;

      var stage = STAGE_BY_DEPTH[node.depth];
      var m;
      if (node.depth === 4) {
        m = node.fd; // positional
      } else {
        m = (a && b) ? byPair[stage][pairKey(a.code, b.code)] : null;
        node.fd = m;
      }
      if (m) attached[m.id] = true;

      node.status = m ? m.status : 'TBD';
      node.scoreLine = scoreLine(m);
      node.kickoff = m ? m.utcDate : null;

      var wt = winnerTla(m);
      node.winner = null;
      if (wt) {
        if (a && wt === a.code) node.winner = a;
        else if (b && wt === b.code) node.winner = b;
        else {
          node.winner = Data.resolveTeam((m.homeTeam && m.homeTeam.tla === wt) ? m.homeTeam : m.awayTeam);
          if (a && b) warnings.push('Stage ' + stage + ': winner ' + wt + ' not in expected pair ' + a.code + '/' + b.code);
        }
      }
      return node.winner;
    }
    resolve(root);

    // Orphan check: any finished deeper match with both teams should have been
    // attached to a node. If not, the structure/data disagree.
    DEEPER.forEach(function (s) {
      (stages[s] || []).forEach(function (m) {
        if (m.status === 'FINISHED' && m.homeTeam && m.homeTeam.tla && m.awayTeam && m.awayTeam.tla && !attached[m.id]) {
          warnings.push('Unmatched finished ' + s + ' match: ' + m.homeTeam.tla + ' v ' + m.awayTeam.tla);
        }
      });
    });

    function winnerOf(n) { return n.children.length ? n.winner : n.team; }
    Bracket.allNodes(root).forEach(function (n) {
      if (!n.parent) return;
      var p = n.parent;
      n.isWinnerEdge = !!(p.winner && winnerOf(n) && p.winner.code === winnerOf(n).code);
      n.isLoserEdge = !!(p.winner && winnerOf(n) && p.winner.code !== winnerOf(n).code);
    });

    var counts = {
      finished: matches.filter(function (m) { return m.status === 'FINISHED'; }).length,
      total: matches.length
    };
    return { root: root, warnings: warnings, counts: counts, winnerOf: winnerOf };
  }

  var Data = global.TeamData;
  global.Results = { build: build, winnerTla: winnerTla, scoreLine: scoreLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Results;
})(typeof window !== 'undefined' ? window : globalThis);
