#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDir, statePath, readInstance, instanceUrl } from '../src/runtime.js';
import { installStartup } from '../src/startup.js';
import { createRequire } from 'node:module';

const command = process.argv[2] || 'start';
if (!['start', 'status', 'close', '--help', '-h', '--version', '-v'].includes(command) || process.argv.length > 3) {
  console.error('Usage: indri [start|status|close|--help|--version]'); process.exit(1);
}
if (command === '--help' || command === '-h') {
  console.log('indri          Start or reuse the persistent local server\nindri status   Show the current review and MCP URLs\nindri close    Stop the server; keep all diagrams\n\nData: ' + dataDir); process.exit(0);
}
if (command === '--version' || command === '-v') {
  console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version); process.exit(0);
}

async function lock() {
  const path = join(dataDir, 'cli.lock'), deadline = Date.now() + 30000;
  while (true) {
    try { const file = await open(path, 'wx', 0o600); await file.writeFile(String(process.pid)); await file.close(); return () => unlink(path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { await unlink(path); continue; } throw error; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error('Another Indri command is still running. Try again shortly.');
      await delay(100);
    }
  }
}

async function healthy(instance) {
  if (!instance) return false;
  try {
    const response = await fetch(instanceUrl(instance) + '/health', { signal: AbortSignal.timeout(1500) });
    const data = await response.json();
    return response.ok && data.service === 'indri' && data.pid === instance.pid;
  } catch { return false; }
}

let pm2, unlock;
try {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  unlock = await lock();
  process.env.PM2_HOME = join(dataDir, 'pm2');
  ({ default: pm2 } = await import('pm2'));
  const pm = (method, ...args) => new Promise((resolve, reject) => pm2[method](...args, (err, result) => err ? reject(err) : resolve(result)));
  await pm('connect');
  const processes = await pm('describe', 'indri');
  let instance = command === 'close' ? null : readInstance();
  if (command === 'close') {
    if (processes.length) await pm('delete', 'indri');
    await pm('dump', true);
    await unlink(statePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    console.log('Indri closed. Diagrams are saved in ' + dataDir);
  } else if (command === 'status') {
    if (!processes.length || !await healthy(instance)) { console.log('Indri is not running. Start it with: indri'); }
    else console.log(`Review: ${instanceUrl(instance)}\nMCP:    ${instanceUrl(instance)}/mcp\nData:   ${dataDir}`);
  } else {
    if (!processes.length || !await healthy(instance)) {
      if (processes.length) await pm('delete', 'indri');
      await pm('start', {
        name: 'indri', script: fileURLToPath(new URL('../src/server.js', import.meta.url)), interpreter: process.execPath,
        cwd: dataDir, instances: 1, exec_mode: 'fork', autorestart: true, watch: false,
        wait_ready: true, listen_timeout: 15000, kill_timeout: 5000, restart_delay: 1000, max_memory_restart: '256M',
        env: { NODE_ENV: 'production', PORT: String(instance?.port || 4317), INDRI_MANAGED: '1',
          INDRI_DATA_DIR: dataDir, INDRI_DB_PATH: join(dataDir, 'indri.sqlite') },
      });
      const deadline = Date.now() + 15000;
      while (true) {
        instance = readInstance();
        if (await healthy(instance)) break;
        if (Date.now() >= deadline) throw new Error('Indri did not become ready. See logs in ' + join(dataDir, 'pm2/logs'));
        await delay(100);
      }
      await pm('dump');
    }
    await installStartup(dataDir, createRequire(import.meta.url).resolve('pm2/bin/pm2')).catch(error => {
      console.error('Indri is running, but login startup was not installed: ' + error.message);
    });
    console.log(`Review: ${instanceUrl(instance)}\nMCP:    ${instanceUrl(instance)}/mcp\nData:   ${dataDir}\nStop:   indri close`);
  }
} catch (error) { console.error('Indri: ' + error.message); process.exitCode = 1; }
finally { pm2?.disconnect(); if (unlock) await unlock(); }
