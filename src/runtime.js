import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';

export const dataDir = resolve(process.env.INDRI_DATA_DIR || join(homedir(), '.indri'));
export const statePath = join(dataDir, 'server.json');
export const instanceSchema = z.object({ port: z.number().int().min(1).max(65535), pid: z.number().int().positive() });
export function readInstance(path = statePath) {
  try { return instanceSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeInstance(instance, path = statePath) {
  writeFileSync(path + '.tmp', JSON.stringify(instanceSchema.parse(instance)), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export function instanceUrl(instance) { return `http://127.0.0.1:${instance.port}`; }
