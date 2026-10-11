import { layoutGraph, selectionContext } from '../src/layout.js';

const $ = selector => document.querySelector(selector);
$('#mcp-endpoint').textContent = location.origin + '/mcp';
const diagramId = new URLSearchParams(location.search).get('diagram');
let doc, target = { type: 'diagram' }, targetRevision, zoom = 1, bounds, layout, gesture, suppressClick = false;
let tool = 'pan', pan = { x: 0, y: 0 };
let viewedRevision = new URLSearchParams(location.search).get('revision');
const svgNS = 'http://www.w3.org/2000/svg';
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const svg = (tag, attributes = {}, text) => {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function error(err) { $('#error').textContent = err.message; $('#error').hidden = false; }
function clearError() { $('#error').hidden = true; }
function interactive(group, label, action) {
  group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0'); group.setAttribute('aria-label', label);
  group.addEventListener('click', action);
  group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } });
}
function sameTarget(a, b) { return a.type === b.type && (a.type === 'region'
  ? ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]) : a.id === b.id); }
function select(next, revision = doc.revision) { target = next; targetRevision = revision; renderSelection(); renderComments(); highlight(); renderRegions(); }
function highlight() {
  for (const node of $('#drawing').querySelectorAll('[data-type]')) {
    node.classList.toggle('selected', sameTarget(target, { type: node.dataset.type, id: node.dataset.id }));
  }
}
function sourceText(node) { return node.source ? `${node.source.path}${node.source.line ? ':' + node.source.line : ''}` : ''; }
function renderSelection() {
  const box = $('#selection'); box.replaceChildren();
  const region = target.type === 'region';
  const item = target.type === 'diagram' || region ? null : (target.type === 'node' ? doc.graph.nodes : doc.graph.edges).find(n => n.id === target.id);
  box.append(el('strong', region ? 'Selected area' : target.type === 'diagram' ? 'Whole diagram' : item?.label || target.id));
  if (region) {
    const context = targetRevision === doc.revision ? selectionContext(layout, target) : doc.comments.find(c => c.revision === targetRevision && sameTarget(c.target, target))?.context;
    const selected = context?.nodes.filter(node => node.selected) || [];
    box.append(el('p', selected.length ? selected.map(node => node.label).join(', ') : `Near ${context?.nodes[0]?.label || 'empty space'}`));
    if (targetRevision !== doc.revision) box.append(el('p', `Location from version ${targetRevision}. Open that version to see it.`));
  }
  if (item?.description) box.append(el('p', item.description));
  if (target.type === 'node' && item?.source) box.append(el('p', sourceText(item)));
  if (target.type !== 'diagram') {
    if (!region) box.append(el('p', `${target.type === 'node' ? 'Element' : 'Connection'} · ${target.id}${!item ? ' · Removed' : ''}`));
    const reset = el('button', 'Comment on whole diagram'); reset.type = 'button'; reset.onclick = () => select({ type: 'diagram' }); box.append(reset);
  }
  $('#comment-form button').disabled = doc.current_revision !== doc.revision || (region ? targetRevision !== doc.revision : target.type !== 'diagram' && !item);
}
function applyDoc(next) {
  doc = next;
  $('#title').textContent = doc.graph.title; document.title = `${doc.graph.title} · Indri`;
  $('#description').textContent = doc.graph.description;
  $('#revision').textContent = `Revision ${doc.revision}`;
  $('#restore').hidden = doc.current_revision === doc.revision;
  $('#history-notice').hidden = doc.current_revision === doc.revision;
  $('#select-area').disabled = doc.current_revision !== doc.revision;
  if ($('#select-area').disabled) setTool('pan');
  $('#kind-label').textContent = doc.graph.kind === 'sketch' ? 'ROUGH SKETCH / UX REVIEW' : 'DIAGRAM / CODE REVIEW';
  renderDrawing(); renderSelection(); renderComments();
}
function renderDrawing() {
  const drawing = $('#drawing'); drawing.replaceChildren();
  const marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#96a093' }));
  const defs = svg('defs'); defs.append(marker); drawing.append(defs);
  layout = layoutGraph(doc.graph);
  bounds = layout.bounds;
  const positions = new Map(layout.nodes.map(node => [node.id, { ...node, x: node.x + node.width / 2, y: node.y + node.height / 2 }]));
  const addEdges = () => {
    for (const edge of doc.graph.edges) {
      const geometry = layout.edges.find(item => item.id === edge.id);
      const points = geometry.points;
      const d = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
      const group = svg('g', { class: 'element edge', 'data-type': 'edge', 'data-id': edge.id });
      group.append(svg('path', { d, class: 'edge-line', 'marker-end': 'url(#arrow)' }), svg('path', { d, class: 'edge-hit' }));
      if (edge.label) group.append(svg('text', { x: geometry.x, y: geometry.y, 'text-anchor': 'middle', class: 'edge-label' }, edge.label));
      interactive(group, `Comment on connection: ${edge.label || edge.id}`, () => select({ type: 'edge', id: edge.id }));
      drawing.append(group);
    }
  };
  const addNode = node => {
    const { x, y } = positions.get(node.id);
    const left = x - node.width / 2, top = y - node.height / 2;
    const group = svg('g', { class: `element ${node.shape}`, 'data-type': 'node', 'data-id': node.id });
    const shape = node.shape === 'ellipse'
      ? svg('ellipse', { cx: x, cy: y, rx: node.width / 2, ry: node.height / 2, class: 'outline' })
      : svg('rect', { x: left, y: top, width: node.width, height: node.height, rx: node.shape === 'frame' ? 2 : 7, class: 'outline' });
    group.append(shape);
    if (node.shape === 'stroke') {
      group.append(svg('path', { d: node.points.map((p, i) => `${i ? 'L' : 'M'} ${left + p.x} ${top + p.y}`).join(' '), class: 'stroke-line' }));
    } else {
      const chars = Math.max(6, Math.floor((node.width - 20) / 7.5));
      const lines = node.label.match(new RegExp(`.{1,${chars}}`, 'g')) || [''];
      lines.slice(0, Math.max(1, Math.floor((node.height - 14) / 18))).forEach((line, i) => {
        group.append(svg('text', { x: node.shape === 'frame' ? left + 12 : x,
          y: node.shape === 'frame' ? top + 22 + i * 18 : y - (Math.min(lines.length, Math.max(1, Math.floor((node.height - 14) / 18))) - 1) * 9 + i * 18 + 4,
          'text-anchor': node.shape === 'frame' ? 'start' : 'middle' }, line));
      });
    }
    const count = doc.comments.filter(c => c.status === 'open' && c.target.type === 'node' && c.target.id === node.id).length;
    if (count) { group.append(svg('circle', { cx: left + node.width - 5, cy: top + 5, r: 10, class: 'badge' }));
      const label = svg('text', { x: left + node.width - 5, y: top + 9, 'text-anchor': 'middle', fill: '#fff' }, String(count)); label.setAttribute('class', 'badge-text'); group.append(label); }
    interactive(group, `Comment on ${node.label}`, () => select({ type: 'node', id: node.id }));
    drawing.append(group);
  };
  for (const node of doc.graph.nodes.filter(n => n.shape === 'frame')) addNode(node);
  addEdges();
  for (const node of doc.graph.nodes.filter(n => n.shape !== 'frame')) addNode(node);
  drawing.append(svg('g', { id: 'regions' }));
  resize(); highlight();
}
function renderRegions() {
  const group = $('#regions'); if (!group) return; group.replaceChildren();
  const addRegion = (region, number, action, selected = false) => {
    const pin = svg('g', { class: `comment-region${selected ? ' selected' : ''}` });
    if (region.width || region.height) pin.append(svg('rect', { x: region.x, y: region.y, width: region.width, height: region.height, class: 'region-outline' }));
    const marker = svg('g', { transform: `translate(${region.x} ${region.y}) scale(${1 / zoom})`, class: 'region-pin' });
    marker.append(svg('circle', { r: 12 }), svg('text', { y: 4, 'text-anchor': 'middle' }, number)); pin.append(marker);
    if (action) interactive(marker, `Open area comment ${number}`, action);
    group.append(pin);
  };
  const visible = doc.comments.filter(c => c.target.type === 'region' && !c.outdated && (c.status === 'open' || $('#show-resolved').checked));
  visible.forEach(thread => addRegion(thread.target, String(doc.comments.indexOf(thread) + 1), () => select(thread.target, thread.revision), sameTarget(target, thread.target) && targetRevision === thread.revision));
  if (target.type === 'region' && targetRevision === doc.revision && !visible.some(c => sameTarget(c.target, target))) addRegion(target, '+', null, true);
  if (gesture?.region) group.append(svg('rect', { ...gesture.region, class: 'region-outline selecting' }));
}
function resize() {
  if (!bounds) return;
  const regions = doc.comments.filter(c => c.target.type === 'region' && !c.outdated).map(c => c.target);
  if (target.type === 'region' && targetRevision === doc.revision) regions.push(target);
  const width = Math.max(bounds.width, ...regions.map(r => r.x + r.width + 20), ($('#canvas').clientWidth - 56) / zoom);
  const height = Math.max(bounds.height, ...regions.map(r => r.y + r.height + 20), ($('#canvas').clientHeight - 56) / zoom);
  $('#drawing').setAttribute('viewBox', `${pan.x} ${pan.y} ${width} ${height}`);
  $('#drawing').setAttribute('width', width * zoom);
  $('#drawing').setAttribute('height', height * zoom);
  renderRegions();
}
function fit() {
  if (!bounds) return;
  pan = { x: 0, y: 0 }; $('#canvas').scrollLeft = 0; $('#canvas').scrollTop = 0;
  zoom = Math.min(1.4, Math.max(.1, Math.min(($('#canvas').clientWidth - 56) / bounds.width, ($('#canvas').clientHeight - 56) / bounds.height))); resize();
}
function renderComments() {
  $('#open-count').textContent = `${doc.comments.filter(c => c.status === 'open').length} open`;
  const comments = $('#comments'); comments.replaceChildren();
  const threads = doc.comments.filter(c => ($('#show-resolved').checked || c.status === 'open') && (target.type === 'diagram' || (sameTarget(target, c.target) && (target.type !== 'region' || c.revision === targetRevision))));
  if (!threads.length) comments.append(el('p', 'No feedback here yet. Leave a question or suggest a change.', 'empty'));
  for (const thread of threads) {
    const box = el('article', undefined, 'thread');
    const anchor = el('button', thread.target.type === 'region' ? `Area ${doc.comments.indexOf(thread) + 1} · ${thread.context?.nodes[0]?.label || 'Empty space'}` : `${thread.target.type.toUpperCase()} · ${thread.target_label}`, 'thread-target');
    anchor.onclick = async () => {
      try {
        if (thread.outdated) {
          viewedRevision = String(thread.revision);
          const url = new URL(location.href); url.searchParams.set('revision', viewedRevision); history.replaceState(null, '', url);
          await refresh();
        }
        select(thread.target, thread.revision);
      } catch (err) { error(err); }
    }; box.append(anchor);
    box.append(el('div', `Version ${thread.revision} · ${thread.status}${thread.orphaned ? ' · Element removed' : ''}${thread.outdated ? ' · Earlier drawing' : ''}`, 'thread-meta'));
    for (const message of thread.messages) {
      const section = el('div', undefined, 'message'); section.append(el('strong', message.author), el('p', message.body)); box.append(section);
    }
    if (doc.current_revision !== doc.revision) { comments.append(box); continue; }
    const reply = el('form'); reply.hidden = true;
    const label = el('label', 'Reply'); const input = el('textarea'); input.rows = 2; input.required = true; input.maxLength = 10000; input.id = `reply-${thread.id}`; label.htmlFor = input.id;
    const submit = el('button', 'Send reply', 'primary'); submit.type = 'submit'; reply.append(label, input, submit);
    reply.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true;
      try { clearError(); applyDoc(await api(`/api/diagrams/${doc.id}/comments/${thread.id}/replies`, 'POST', { author: $('#author').value, body: input.value })); $('#status').textContent = 'Reply saved.'; }
      catch (err) { error(err); submit.disabled = false; }
    };
    const actions = el('div', undefined, 'thread-actions');
    const replyButton = el('button', 'Reply'); replyButton.onclick = () => { reply.hidden = !reply.hidden; if (!reply.hidden) input.focus(); };
    const resolveButton = el('button', thread.status === 'open' ? 'Resolve' : 'Reopen');
    resolveButton.onclick = async () => {
      resolveButton.disabled = true;
      try { clearError(); applyDoc(await api(`/api/diagrams/${doc.id}/comments/${thread.id}`, 'PATCH', { status: thread.status === 'open' ? 'resolved' : 'open' })); }
      catch (err) { error(err); resolveButton.disabled = false; }
    };
    actions.append(replyButton, resolveButton); box.append(actions, reply); comments.append(box);
  }
}
async function refresh() {
  clearError();
  if (diagramId) {
    const path = `/api/diagrams/${encodeURIComponent(diagramId)}`;
    const [next, versions] = await Promise.all([api(path + (viewedRevision ? `?revision=${encodeURIComponent(viewedRevision)}` : '')), api(path + '/versions')]);
    const select = $('#versions'); select.replaceChildren();
    for (const version of versions) { const option = el('option', `Version ${version.revision}${version.revision === next.current_revision ? ' · Current' : ''}`); option.value = version.revision; select.append(option); }
    select.value = next.revision;
    applyDoc(next);
  } else {
    const list = await api('/api/diagrams'); const container = $('#diagram-list'); container.replaceChildren();
    $('#list-count').textContent = `${list.length} in workspace`;
    if (!list.length) container.append(el('p', 'No diagrams yet. Connect an agent below to draw your first one.', 'empty'));
    for (const item of list) {
      const link = el('a', undefined, 'diagram-card'); link.href = `/?diagram=${encodeURIComponent(item.id)}`;
      link.append(el('h3', item.title), el('p', `${item.open_comments} open comments · Revision ${item.revision}`), el('p', `Updated ${new Date(item.updated_at).toLocaleString()}`)); container.append(link);
    }
  }
}
$('#comment-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#comment-form button'); button.disabled = true;
  const body = $('#body').value;
  try { clearError(); applyDoc(await api(`/api/diagrams/${doc.id}/comments`, 'POST', { author: $('#author').value, body, target, expected_revision: doc.revision }));
    if ($('#body').value === body) $('#body').value = '';
    $('#status').textContent = 'Comment saved.'; }
  catch (err) { error(err); }
  finally { renderSelection(); }
};
$('#show-resolved').onchange = () => { renderComments(); renderRegions(); };
$('#versions').onchange = async event => {
  viewedRevision = Number(event.target.value) === doc.current_revision ? null : event.target.value;
  const url = new URL(location.href);
  if (viewedRevision) url.searchParams.set('revision', viewedRevision); else url.searchParams.delete('revision');
  history.replaceState(null, '', url);
  target = { type: 'diagram' }; targetRevision = undefined;
  try { await refresh(); fit(); } catch (err) { error(err); }
};
$('#restore').onclick = async () => {
  $('#restore').disabled = true;
  try {
    clearError();
    await api(`/api/diagrams/${doc.id}/restore`, 'POST', { revision: doc.revision, expected_revision: doc.current_revision });
    viewedRevision = null; target = { type: 'diagram' }; targetRevision = undefined;
    const url = new URL(location.href); url.searchParams.delete('revision'); history.replaceState(null, '', url);
    await refresh(); fit(); $('#status').textContent = 'Drawing restored as a new version.';
  } catch (err) { error(err); }
  finally { $('#restore').disabled = false; }
};

function drawingPoint(event) {
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform($('#drawing').getScreenCTM().inverse());
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
}
function setTool(next) {
  tool = next; $('#canvas').dataset.tool = next;
  $('#move-view').setAttribute('aria-pressed', String(next === 'pan'));
  $('#select-area').setAttribute('aria-pressed', String(next === 'select'));
  $('#canvas-hint').textContent = next === 'pan' ? 'Drag to move the diagram. Click an object to comment, or choose Select area.' : 'Drag a rectangle or click a spot to comment. Esc returns to Move view.';
}
$('#move-view').onclick = () => setTool('pan');
$('#select-area').onclick = () => setTool('select');
$('#canvas').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || !doc || (tool === 'select' && doc.revision !== doc.current_revision)) return;
  gesture = { tool, pan: { ...pan }, start: drawingPoint(event), clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
});
$('#canvas').addEventListener('pointermove', event => {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (!gesture.moved && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 5) return;
  gesture.moved = true;
  event.preventDefault(); $('#canvas').setPointerCapture(event.pointerId);
  if (gesture.tool === 'pan') {
    pan = { x: gesture.pan.x - (event.clientX - gesture.clientX) / zoom, y: gesture.pan.y - (event.clientY - gesture.clientY) / zoom };
    $('#canvas').classList.add('panning'); resize(); return;
  }
  const point = drawingPoint(event), start = gesture.start;
  gesture.region = { type: 'region', x: Math.min(point.x, start.x), y: Math.min(point.y, start.y),
    width: Math.round(Math.abs(point.x - start.x) * 10) / 10, height: Math.round(Math.abs(point.y - start.y) * 10) / 10 };
  renderRegions();
});
$('#canvas').addEventListener('pointerup', () => {
  const completed = gesture; gesture = null; $('#canvas').classList.remove('panning');
  if (completed?.moved) suppressClick = true;
  if (completed?.region) { select(completed.region); setTool('pan'); $('#body').focus(); }
});
$('#canvas').addEventListener('pointercancel', () => { gesture = null; $('#canvas').classList.remove('panning'); renderRegions(); });
$('#canvas').addEventListener('click', event => {
  if (suppressClick) { suppressClick = false; event.stopImmediatePropagation(); return; }
  if (tool !== 'select' || !doc || doc.revision !== doc.current_revision || event.target.closest('.comment-region')) return;
  event.stopImmediatePropagation();
  const point = drawingPoint(event);
  select({ type: 'region', ...point, width: 0, height: 0 }); setTool('pan'); $('#body').focus();
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && doc) {
    if (gesture && $('#canvas').hasPointerCapture(gesture.pointerId)) $('#canvas').releasePointerCapture(gesture.pointerId);
    suppressClick = Boolean(gesture); gesture = null; $('#canvas').classList.remove('panning'); setTool('pan'); select({ type: 'diagram' });
  }
});
window.addEventListener('resize', resize);
$('#refresh').onclick = () => refresh().catch(error);
$('#fit').onclick = fit;
$('#zoom-in').onclick = () => { zoom = Math.min(3, zoom * 1.25); resize(); };
$('#zoom-out').onclick = () => { zoom = Math.max(.1, zoom / 1.25); resize(); };
if (diagramId) { $('#review').hidden = false; $('#view-label').textContent = 'Diagram review'; }
else $('#home').hidden = false;
refresh().then(fit).catch(error);
// shortcut: refresh only while no form is being edited; use push updates if live coediting is added.
setInterval(() => {
  if (!gesture && !document.hidden && !document.activeElement?.closest('form') && !$('#body').value &&
      ![...document.querySelectorAll('.thread textarea')].some(input => input.value)) refresh().catch(error);
}, 5000);
