import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { layoutGraph, selectionContext } from '../src/layout.js';

const graph = { title: 'Request flow', nodes: [{ id: 'api', label: 'API' }, { id: 'db', label: 'Database' }], edges: [{ id: 'query', source: 'api', target: 'db', label: 'queries' }] };
const feedback = { author: 'Developer', body: 'Where does validation happen?', target: { type: 'node', id: 'api' }, expected_revision: 1 };

test('feedback survives redraws, removed targets, replies and status changes', () => {
  const store = new Store(':memory:');
  try {
    let doc = store.create(graph);
    doc = store.comment(doc.id, feedback);
    const commentId = doc.comments[0].id;
    doc = store.update(doc.id, { expected_revision: 1, graph: { ...graph, nodes: [{ id: 'api', label: 'Validated API' }, graph.nodes[1]] } });
    assert.equal(doc.comments[0].target.id, 'api'); assert.equal(doc.comments[0].orphaned, false);
    doc = store.update(doc.id, { expected_revision: 2, graph: { title: graph.title, nodes: [graph.nodes[1]] } });
    assert.equal(doc.comments[0].orphaned, true); assert.equal(doc.comments[0].target_label, 'API');
    doc = store.reply(doc.id, commentId, { author: 'Agent', body: 'Validation moved into middleware.' });
    doc = store.setStatus(doc.id, commentId, { status: 'resolved' });
    assert.equal(doc.comments[0].messages.length, 2); assert.equal(doc.comments[0].status, 'resolved');
    assert.equal(store.setStatus(doc.id, commentId, { status: 'open' }).comments[0].status, 'open');
  } finally { store.close(); }
});

test('reject stale writes, invalid graphs, unknown targets and empty messages without losing data', () => {
  const store = new Store(':memory:');
  try {
    const doc = store.create(graph);
    store.update(doc.id, { expected_revision: 1, graph });
    assert.throws(() => store.update(doc.id, { expected_revision: 1, graph }), /revision 2/);
    assert.throws(() => store.comment(doc.id, feedback), /revision 2/);
    assert.throws(() => store.create({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }), /unique/);
    assert.throws(() => store.create({ ...graph, edges: [{ id: 'bad', source: 'api', target: 'missing' }] }), /missing node/);
    assert.throws(() => store.comment(doc.id, { ...feedback, expected_revision: 2, target: { type: 'node', id: 'missing' } }), /does not exist/);
    assert.throws(() => store.comment(doc.id, { ...feedback, expected_revision: 2, body: '   ' }));
    assert.equal(store.get(doc.id).comments.length, 0); assert.equal(store.get(doc.id).revision, 2);
  } finally { store.close(); }
});

test('sketches require positions; freehand strokes stay inside their element', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.create({ ...graph, kind: 'sketch' }), /coordinates/);
    const sketch = { kind: 'sketch', title: 'Login UX', nodes: [
      { id: 'screen', label: 'Login', shape: 'frame', x: 10, y: 10, width: 360, height: 600 },
      { id: 'submit', label: 'Sign in', x: 40, y: 450, width: 300, height: 50 },
      { id: 'annotation', label: 'Arrow', shape: 'stroke', x: 10, y: 400, width: 60, height: 40, points: [{ x: 0, y: 0 }, { x: 60, y: 40 }] },
    ] };
    let doc = store.create(sketch); doc = store.comment(doc.id, { ...feedback, target: { type: 'node', id: 'submit' } });
    assert.equal(doc.comments[0].target_label, 'Sign in'); assert.equal(doc.graph.nodes[2].points.length, 2);
    assert.throws(() => store.create({ ...sketch, nodes: [{ ...sketch.nodes[2], points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }] }), /within/);
  } finally { store.close(); }
});

test('SQLite survives reopening and preserves simultaneous comment writers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'indri-')); const path = join(dir, 'store.sqlite');
  let a, b;
  try {
    a = new Store(path); const doc = a.create(graph); b = new Store(path);
    a.comment(doc.id, feedback); b.comment(doc.id, { ...feedback, body: 'Second reviewer' });
    a.comment(doc.id, { ...feedback, target: { type: 'region', x: 25, y: 25, width: 10, height: 10 } });
    a.close(); a = new Store(path);
    assert.equal(a.get(doc.id).comments.length, 3); assert.equal(a.list()[0].open_comments, 3);
    assert.ok(a.get(doc.id).comments[2].context.nodes.some(n => n.id === 'api'));
  } finally { a?.close(); b?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('area comments retain selected objects and old coordinates through revisions and restores', () => {
  const store = new Store(':memory:');
  try {
    const doc = store.create(graph), layout = layoutGraph(doc.graph), node = layout.nodes[0];
    const target = { type: 'region', x: node.x + 10, y: node.y + 10, width: 60, height: 20 };
    let updated = store.comment(doc.id, { ...feedback, target });
    const context = updated.comments[0].context;
    assert.equal(context.nodes[0].id, 'api'); assert.equal(context.nodes[0].selected, true);
    assert.deepEqual(store.getSelectionContext(doc.id, { target, revision: 1 }), context);
    updated = store.update(doc.id, { expected_revision: 1, graph: { title: 'Changed layout', nodes: [graph.nodes[1]] } });
    assert.equal(updated.comments[0].outdated, true); assert.deepEqual(updated.comments[0].context, context);
    assert.deepEqual(store.getSelectionContext(doc.id, { target, revision: 1 }), context);
    assert.equal(store.get(doc.id, 1).graph.nodes[0].label, 'API');
    assert.equal(store.get(doc.id, 1).current_revision, 2);
    updated = store.restore(doc.id, { revision: 1, expected_revision: 2 });
    assert.equal(updated.revision, 3); assert.equal(updated.graph.nodes[0].label, 'API');
    assert.deepEqual(store.versions(doc.id).map(v => v.revision), [3, 2, 1]);
    assert.equal(store.get(doc.id, 2).graph.title, 'Changed layout');
    assert.throws(() => store.restore(doc.id, { revision: 1, expected_revision: 2 }), /revision 3/);
    assert.throws(() => store.get(doc.id, 99), /revision not found/);
    assert.throws(() => store.comment(doc.id, { ...feedback, expected_revision: 3, target: { ...target, x: -1000001 } }));
    assert.throws(() => store.getSelectionContext(doc.id, { target: { ...target, width: -1 } }));
  } finally { store.close(); }
});

test('region context includes intersecting edges, all selected objects, nearby objects and empty-space points', () => {
  const store = new Store(':memory:');
  try {
    const doc = store.create({ kind: 'sketch', title: 'Selection geometry', nodes: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `item${i}`, label: `Item ${i}`, x: i * 20, y: 0, width: 10, height: 10 })),
      { id: 'far', label: 'Far away', x: 200, y: 200, width: 10, height: 10 },
    ], edges: [{ id: 'diagonal', source: 'item0', target: 'far' }] });
    const context = store.getSelectionContext(doc.id, { target: { type: 'region', x: 0, y: 0, width: 170, height: 15 } });
    assert.equal(context.nodes.filter(n => n.selected).length, 8); assert.equal(context.nodes.at(-1).id, 'far');
    const crossing = store.getSelectionContext(doc.id, { target: { type: 'region', x: 100, y: 100, width: 10, height: 10 } });
    assert.equal(crossing.edges[0].selected, true); assert.equal(crossing.nodes.filter(n => n.selected).length, 0);
    const point = selectionContext(layoutGraph(doc.graph), { type: 'region', x: 5, y: 5, width: 0, height: 0 });
    assert.equal(point.nodes[0].id, 'item0'); assert.equal(point.nodes[0].distance, 0);
    const miss = store.getSelectionContext(doc.id, { target: { type: 'region', x: 100, y: 40, width: 10, height: 10 } });
    assert.ok(miss.edges[0].distance > 0);
    const negative = store.comment(doc.id, { ...feedback, target: { type: 'region', x: -20, y: -20, width: 5, height: 5 } });
    assert.equal(negative.comments[0].context.selection.x, -20);
    assert.equal(negative.comments[0].context.nodes[0].selected, false);
  } finally { store.close(); }
});

test('MCP → browser feedback → agent revision/reply/resolution, plus HTTP boundary protection', async () => {
  const { app, store, mcp } = createApp({ dbPath: ':memory:' });
  const http = app.listen(0, '127.0.0.1'); await new Promise(resolve => http.once('listening', resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  const client = new Client({ name: 'indri-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.equal((await client.listTools()).tools.length, 10);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent;
    };
    let doc = await call('create_diagram', { graph });
    assert.ok(doc.review_url.endsWith(doc.id));
    let response = await fetch(`${base}/api/diagrams/${doc.id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feedback) });
    assert.equal(response.status, 200);
    doc = await call('get_comments', { diagram_id: doc.id }); assert.equal(doc.comments[0].messages[0].body, feedback.body);
    const commentId = doc.comments[0].id;
    doc = await call('update_diagram', { diagram_id: doc.id, expected_revision: 1, graph: { ...graph, title: 'Validated request flow' } });
    assert.equal(doc.revision, 2);
    const stale = await client.callTool({ name: 'update_diagram', arguments: { diagram_id: doc.id, expected_revision: 1, graph } }); assert.equal(stale.isError, true);
    await call('reply_to_comment', { diagram_id: doc.id, comment_id: commentId, author: 'Agent', body: 'Added validation.' });
    await call('set_comment_status', { diagram_id: doc.id, comment_id: commentId, status: 'resolved' });
    assert.equal((await call('get_comments', { diagram_id: doc.id })).comments.length, 0);
    assert.equal((await call('get_diagram', { diagram_id: doc.id })).comments[0].messages.length, 2);
    assert.equal((await call('list_diagrams', {})).diagrams.length, 1);
    const node = layoutGraph(doc.graph).nodes[0];
    const target = { type: 'region', x: node.x, y: node.y, width: 40, height: 20 };
    await call('add_comment', { ...feedback, diagram_id: doc.id, expected_revision: 2, target });
    const areaComments = await call('get_comments', { diagram_id: doc.id });
    assert.equal(areaComments.comments[0].context.nodes[0].id, 'api');
    const context = await call('get_selection_context', { diagram_id: doc.id, target, revision: 2 });
    assert.equal(context.nodes[0].selected, true);
    assert.equal((await call('list_diagram_versions', { diagram_id: doc.id })).versions.length, 2);
    const historical = await call('get_diagram', { diagram_id: doc.id, revision: 1 });
    assert.equal(historical.graph.title, graph.title);
    assert.equal(new URL(historical.review_url).searchParams.get('diagram'), doc.id);
    assert.equal(new URL(historical.review_url).searchParams.get('revision'), '1');
    assert.equal(new URL((await call('get_diagram', { diagram_id: doc.id })).review_url).searchParams.get('revision'), null);
    response = await fetch(`${base}/api/diagrams`, { headers: { Origin: 'https://evil.example' } }); assert.equal(response.status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/diagrams`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostStatus, 403);
    response = await fetch(`${base}/api/diagrams/${doc.id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feedback) }); assert.equal(response.status, 409);
    response = await fetch(`${base}/api/diagrams/${doc.id}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(response.status, 400);
  } finally { await client.close(); await mcp.close(); await new Promise(resolve => http.close(resolve)); store.close(); }
});
