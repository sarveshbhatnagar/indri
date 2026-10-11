import dagre from '@dagrejs/dagre';

export function layoutGraph(input) {
  const graph = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: input.direction, nodesep: 45, ranksep: 85, marginx: 25, marginy: 25 }).setDefaultEdgeLabel(() => ({}));
  for (const node of input.nodes) graph.setNode(node.id, { width: node.width, height: node.height });
  for (const edge of input.edges) graph.setEdge(edge.source, edge.target, { width: Math.min(edge.label.length * 7, 300), height: 20 }, edge.id);
  if (input.kind === 'diagram') dagre.layout(graph);
  const nodes = input.nodes.map(node => {
    const p = graph.node(node.id);
    return { ...node, x: input.kind === 'sketch' ? node.x : p.x - node.width / 2, y: input.kind === 'sketch' ? node.y : p.y - node.height / 2 };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = input.edges.map(edge => {
    if (input.kind === 'diagram') return { ...edge, ...graph.edge({ v: edge.source, w: edge.target, name: edge.id }) };
    const a = byId.get(edge.source), b = byId.get(edge.target);
    return { ...edge, points: [{ x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 }],
      x: (a.x + a.width / 2 + b.x + b.width / 2) / 2, y: (a.y + a.height / 2 + b.y + b.height / 2) / 2 - 10 };
  });
  const bounds = input.kind === 'sketch'
    ? { width: Math.max(...nodes.map(n => n.x + n.width)) + 30, height: Math.max(...nodes.map(n => n.y + n.height)) + 30 }
    : { width: graph.graph().width, height: graph.graph().height };
  return { nodes, edges, bounds };
}

function boxDistance(a, b) {
  return Math.hypot(Math.max(a.x - b.x - b.width, b.x - a.x - a.width, 0), Math.max(a.y - b.y - b.height, b.y - a.y - a.height, 0));
}
function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function edgeDistance(a, b, rect) {
  let low = 0, high = 1;
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const delta = b[axis] - a[axis];
    if (!delta) { if (a[axis] < rect[axis] || a[axis] > rect[axis] + rect[size]) { low = 1; high = 0; } }
    else {
      const first = (rect[axis] - a[axis]) / delta, last = (rect[axis] + rect[size] - a[axis]) / delta;
      low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last));
    }
  }
  if (low <= high) return 0;
  const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height }, { x: rect.x + rect.width, y: rect.y + rect.height }];
  return Math.min(boxDistance({ ...a, width: 0, height: 0 }, rect), boxDistance({ ...b, width: 0, height: 0 }, rect), ...corners.map(p => segmentDistance(p, a, b)));
}

export function selectionContext(layout, selection) {
  const nodes = layout.nodes.map(node => ({ ...node, distance: boxDistance(node, selection) }))
    .sort((a, b) => a.distance - b.distance || a.width * a.height - b.width * b.height);
  const edges = layout.edges.map(edge => ({ ...edge, distance: Math.min(...edge.points.slice(1).map((p, i) => edgeDistance(edge.points[i], p, selection))) }))
    .sort((a, b) => a.distance - b.distance);
  const nearby = (items, count) => items.slice(0, items.filter(item => item.distance === 0).length + count).map(item => ({ ...item, selected: item.distance === 0 }));
  return { selection, nodes: nearby(nodes, 5), edges: nearby(edges, 3) };
}
