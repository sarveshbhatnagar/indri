import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AppError, id, graphSchema, commentSchema, updateSchema, messageSchema, statusSchema, targetLabel, selectionQuerySchema, restoreSchema } from './model.js';
import { layoutGraph, selectionContext } from './layout.js';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS diagrams (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (diagram_id TEXT, revision INTEGER, graph TEXT NOT NULL,
        PRIMARY KEY (diagram_id, revision));`);
  }

  list() {
    return this.db.prepare('SELECT document FROM diagrams ORDER BY rowid DESC').all().map(row => {
      const { id, revision, graph, updated_at, comments } = JSON.parse(row.document);
      return { id, title: graph.title, revision, updated_at, open_comments: comments.filter(c => c.status === 'open').length };
    });
  }

  get(diagramId, revision) {
    id.parse(diagramId);
    const row = this.db.prepare('SELECT document FROM diagrams WHERE id=?').get(diagramId);
    if (!row) throw new AppError(404, 'Diagram not found.');
    const doc = JSON.parse(row.document);
    const currentRevision = doc.revision;
    if (revision !== undefined) {
      z.number().int().positive().parse(revision);
      const snapshot = this.db.prepare('SELECT graph FROM revisions WHERE diagram_id=? AND revision=?').get(diagramId, revision);
      if (!snapshot) throw new AppError(404, 'Diagram revision not found.');
      doc.graph = JSON.parse(snapshot.graph); doc.revision = revision;
      doc.comments = doc.comments.filter(comment => comment.revision <= revision);
    }
    return { ...doc, current_revision: currentRevision, comments: doc.comments.map(comment => ({ ...comment, orphaned: targetLabel(doc.graph, comment.target) === null,
      outdated: comment.target.type === 'region' && comment.revision !== doc.revision })) };
  }

  versions(diagramId) {
    this.get(diagramId);
    return this.db.prepare('SELECT revision, graph FROM revisions WHERE diagram_id=? ORDER BY revision DESC').all(diagramId)
      .map(row => ({ revision: row.revision, title: JSON.parse(row.graph).title }));
  }

  restore(diagramId, input) {
    const { revision, expected_revision } = restoreSchema.parse(input);
    return this.update(diagramId, { expected_revision, graph: this.get(diagramId, revision).graph });
  }

  getSelectionContext(diagramId, input) {
    const { revision, target } = selectionQuerySchema.parse(input);
    const doc = this.get(diagramId);
    const selectedRevision = revision ?? doc.revision;
    const row = this.db.prepare('SELECT graph FROM revisions WHERE diagram_id=? AND revision=?').get(diagramId, selectedRevision);
    if (!row) throw new AppError(404, 'Diagram revision not found.');
    return { revision: selectedRevision, ...selectionContext(layoutGraph(JSON.parse(row.graph)), target) };
  }

  create(input) {
    const graph = graphSchema.parse(input);
    const now = new Date().toISOString();
    const doc = { id: randomUUID(), revision: 1, graph, comments: [], created_at: now, updated_at: now };
    return this.transaction(() => {
      this.save(doc);
      this.recordRevision(doc);
      return doc;
    });
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  save(doc) {
    doc.updated_at = new Date().toISOString();
    delete doc.current_revision;
    this.db.prepare('INSERT INTO diagrams VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
      .run(doc.id, JSON.stringify(doc));
  }

  recordRevision(doc) {
    this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?)').run(doc.id, doc.revision, JSON.stringify(doc.graph));
  }

  mutate(diagramId, action) {
    return this.transaction(() => { const doc = this.get(diagramId); action(doc); this.save(doc); return this.get(diagramId); });
  }

  checkRevision(doc, expected) {
    if (doc.revision !== expected) throw new AppError(409, `Diagram is now revision ${doc.revision}. Read it again before writing.`);
  }

  update(diagramId, input) {
    const { graph, expected_revision } = updateSchema.parse(input);
    return this.mutate(diagramId, doc => {
      this.checkRevision(doc, expected_revision);
      // IDs preserve feedback; removed elements remain visible as orphaned threads.
      doc.graph = graph;
      doc.revision++;
      this.recordRevision(doc);
    });
  }

  comment(diagramId, input) {
    const { target, expected_revision, ...message } = commentSchema.parse(input);
    return this.mutate(diagramId, doc => {
      this.checkRevision(doc, expected_revision);
      const label = targetLabel(doc.graph, target);
      if (label === null) throw new AppError(400, 'Comment target does not exist.');
      doc.comments.push({ id: randomUUID(), target, target_label: label, revision: doc.revision, status: 'open',
        ...(target.type === 'region' ? { context: this.getSelectionContext(diagramId, { target, revision: doc.revision }) } : {}),
        messages: [{ ...message, created_at: new Date().toISOString() }] });
    });
  }

  thread(doc, commentId) {
    id.parse(commentId);
    const thread = doc.comments.find(c => c.id === commentId);
    if (!thread) throw new AppError(404, 'Comment not found.');
    return thread;
  }

  reply(diagramId, commentId, input) {
    const message = messageSchema.parse(input);
    return this.mutate(diagramId, doc => {
      this.thread(doc, commentId).messages.push({ ...message, created_at: new Date().toISOString() });
    });
  }

  setStatus(diagramId, commentId, input) {
    const { status } = statusSchema.parse(input);
    return this.mutate(diagramId, doc => { this.thread(doc, commentId).status = status; });
  }

  close() { this.db.close(); }
}
