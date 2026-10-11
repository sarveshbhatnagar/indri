import { z } from 'zod';

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const text = z.string().trim().min(1);
export const graphSchema = z.object({
  kind: z.enum(['diagram', 'sketch']).default('diagram'),
  title: text.max(200),
  description: z.string().max(10000).default(''),
  direction: z.enum(['LR', 'TB']).default('LR'),
  nodes: z.array(z.object({
    id,
    label: text.max(120),
    description: z.string().max(4000).default(''),
    source: z.object({ path: text.max(500), line: z.number().int().positive().optional() }).optional(),
    shape: z.enum(['box', 'ellipse', 'text', 'frame', 'stroke']).default('box'),
    x: z.number().min(0).max(10000).optional(),
    y: z.number().min(0).max(10000).optional(),
    width: z.number().min(10).max(4000).default(220),
    height: z.number().min(10).max(4000).default(90),
    points: z.array(z.object({ x: z.number().min(0).max(4000), y: z.number().min(0).max(4000) }).strict()).min(2).max(500).optional(),
  }).strict()).min(1).max(100),
  edges: z.array(z.object({ id, source: id, target: id, label: z.string().max(120).default('') }).strict()).max(300).default([]),
}).strict().superRefine((graph, ctx) => {
  const nodes = new Set(graph.nodes.map(node => node.id));
  const edges = new Set(graph.edges.map(edge => edge.id));
  if (nodes.size !== graph.nodes.length || edges.size !== graph.edges.length) {
    ctx.addIssue({ code: 'custom', message: 'Node IDs and edge IDs must each be unique.' });
  }
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      ctx.addIssue({ code: 'custom', message: `Edge ${edge.id} references a missing node.` });
    }
  }
  for (const node of graph.nodes) {
    if (graph.kind === 'sketch' && (node.x === undefined || node.y === undefined)) {
      ctx.addIssue({ code: 'custom', message: `Sketch element ${node.id} needs x and y coordinates.` });
    }
    if (node.shape === 'stroke' && (!node.points || node.points.some(p => p.x > node.width || p.y > node.height))) {
      ctx.addIssue({ code: 'custom', message: `Stroke ${node.id} needs points within its width and height.` });
    }
  }
});

export const regionSchema = z.object({ type: z.literal('region'), x: z.number().min(-1000000).max(1000000), y: z.number().min(-1000000).max(1000000),
  width: z.number().min(0).max(1000000), height: z.number().min(0).max(1000000) }).strict();
export const selectionQuerySchema = z.object({ target: regionSchema, revision: z.number().int().positive().optional() }).strict();
export const targetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('diagram') }).strict(),
  z.object({ type: z.literal('node'), id }).strict(),
  z.object({ type: z.literal('edge'), id }).strict(),
  regionSchema,
]);
export const messageSchema = z.object({ author: text.max(80), body: text.max(10000) }).strict();
export const commentSchema = messageSchema.extend({ target: targetSchema, expected_revision: z.number().int().positive() }).strict();
export const updateSchema = z.object({ expected_revision: z.number().int().positive(), graph: graphSchema }).strict();
export const restoreSchema = z.object({ expected_revision: z.number().int().positive(), revision: z.number().int().positive() }).strict();
export const statusSchema = z.object({ status: z.enum(['open', 'resolved']) }).strict();

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function targetLabel(graph, target) {
  if (target.type === 'diagram') return graph.title;
  if (target.type === 'region') return `Selected area (${target.x}, ${target.y}, ${target.width}, ${target.height})`;
  const item = (target.type === 'node' ? graph.nodes : graph.edges).find(item => item.id === target.id);
  return item ? item.label || `${item.source} → ${item.target}` : null;
}
