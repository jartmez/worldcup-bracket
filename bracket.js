/* bracket.js — pure geometry for the radial World Cup knockout bracket.
 * Single source of truth: a real binary tree (32 -> 16 -> 8 -> 4 -> 2 -> 1).
 * Every node position and every connector path is DERIVED from this tree,
 * so connector geometry can never become ambiguous.
 * Works in the browser (window.Bracket) and in Node (module.exports). */
(function (global) {
  'use strict';

  var N_LEAVES = 32;
  var CX = 500, CY = 500;
  // Radius by depth from root. 0 = final (centre/trophy) ... 5 = leaves (outer ring).
  var RADII = [0, 110, 185, 260, 340, 420];

  // Map a leaf index (0..31) to an angle. Top of circle = -90deg, going clockwise.
  function angleOfIndex(idx) {
    return -90 + ((idx + 0.5) / N_LEAVES) * 360;
  }

  function polar(r, angleDeg) {
    var a = (angleDeg * Math.PI) / 180;
    return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
  }

  var _id = 0;
  function build(lo, hi, depth, parent) {
    var size = hi - lo + 1;
    var idx = (lo + hi) / 2;                 // representative index = mean of covered leaves
    var angle = angleOfIndex(idx);           // so a parent always sits between its two children
    var r = RADII[depth];
    var p = polar(r, angle);
    var node = {
      id: _id++, lo: lo, hi: hi, depth: depth, idx: idx,
      angle: angle, r: r, x: p.x, y: p.y, parent: parent, children: []
    };
    if (size > 1) {
      var half = size / 2;                   // sizes are powers of two, so this is exact
      node.children.push(build(lo, lo + half - 1, depth + 1, node));
      node.children.push(build(lo + half, hi, depth + 1, node));
    }
    return node;
  }

  function buildTree() { _id = 0; return build(0, N_LEAVES - 1, 0, null); }

  function leaves(root) {
    var out = [];
    (function walk(n) { n.children.length ? n.children.forEach(walk) : out.push(n); })(root);
    return out.sort(function (a, b) { return a.idx - b.idx; });
  }

  function allNodes(root) {
    var out = [];
    (function w(n) { out.push(n); n.children.forEach(w); })(root);
    return out;
  }

  /* Connector from a child to its parent, radial-dendrogram style:
   * 1) radial segment straight inward from the child to the parent's radius,
   * 2) an arc along the parent's radius to the parent's exact angle.
   * Both children of a parent terminate at the IDENTICAL parent point, so the
   * convergence is explicit. No floating elbows. */
  function connectorPath(child) {
    var parent = child.parent;
    if (!parent) return '';
    var start = polar(child.r, child.angle);
    var end = polar(parent.r, parent.angle);
    if (parent.r === 0) {
      // Semifinals collapse straight into the centre/trophy.
      return 'M ' + f(start.x) + ' ' + f(start.y) + ' L ' + f(end.x) + ' ' + f(end.y);
    }
    var elbow = polar(parent.r, child.angle);
    var sweep = parent.angle > child.angle ? 1 : 0;
    return 'M ' + f(start.x) + ' ' + f(start.y) +
           ' L ' + f(elbow.x) + ' ' + f(elbow.y) +
           ' A ' + parent.r + ' ' + parent.r + ' 0 0 ' + sweep + ' ' + f(end.x) + ' ' + f(end.y);
  }

  function f(n) { return n.toFixed(2); }

  /* Geometry verification. Proves the rendered tree is a valid bracket:
   *  - exactly 32 leaves,
   *  - every leaf traces a unique path of exactly 6 nodes to the root,
   *  - every internal (match) node has exactly two children that point back to it,
   *  - exactly 31 match nodes (16+8+4+2+1). */
  function verify(root) {
    var lv = leaves(root);
    var paths = lv.map(function (leaf) {
      var path = [], n = leaf;
      while (n) { path.push(n.id); n = n.parent; }
      return path;
    });
    var keys = {};
    var unique = paths.every(function (p) {
      var k = p.join('>'); if (keys[k]) return false; keys[k] = 1; return true;
    });
    var okCount = lv.length === N_LEAVES;
    var okLen = paths.every(function (p) { return p.length === 6; });
    var okRoot = paths.every(function (p) { return p[p.length - 1] === root.id; });
    var internal = allNodes(root).filter(function (n) { return n.children.length; });
    var okPairs = internal.every(function (n) {
      return n.children.length === 2 && n.children.every(function (c) { return c.parent === n; });
    });
    var okMatches = internal.length === 31;
    return {
      leaves: lv.length,
      matches: internal.length,
      pass: okCount && okLen && okRoot && okPairs && okMatches && unique,
      details: { okCount: okCount, okLen: okLen, okRoot: okRoot, okPairs: okPairs, okMatches: okMatches, uniquePaths: unique }
    };
  }

  var api = {
    N_LEAVES: N_LEAVES, CX: CX, CY: CY, RADII: RADII,
    angleOfIndex: angleOfIndex, polar: polar, buildTree: buildTree,
    leaves: leaves, allNodes: allNodes, connectorPath: connectorPath, verify: verify
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Bracket = api;
})(typeof window !== 'undefined' ? window : globalThis);
