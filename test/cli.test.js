import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { macStartup } from '../src/startup.js';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/indri.js', import.meta.url));
const pm2bin = fileURLToPath(new URL('../node_modules/pm2/bin/pm2', import.meta.url));

test('login startup runs the packaged PM2 with explicit paths and isolated state', () => {
  const plist = macStartup('/Users/Test & Co/node', '/Users/Test & Co/pm2', '/Users/Test & Co/.indri/pm2');
  assert.ok(plist.includes('Test &amp; Co'));
  assert.ok(plist.includes('<string>resurrect</string>'));
  assert.ok(plist.includes('<key>PM2_HOME</key>'));
  assert.ok(plist.includes('<key>RunAtLoad</key><true/>'));
});

test('CLI survives terminal exit, reuses one server, changes busy ports and preserves diagrams after close', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indri-cli-'));
  const env = { ...process.env, INDRI_DATA_DIR: dir, PM2_HOME: join(dir, 'pm2') };
  const command = (...args) => run(process.execPath, [cli, ...args], { env, timeout: 25000 });
  const blocker = createServer((req, res) => res.end('This is another app.'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  await writeFile(join(dir, 'server.json'), JSON.stringify({ port: occupied, pid: process.pid }));
  let client;
  try {
    await Promise.all([command(), command()]);
    let instance = JSON.parse(await readFile(join(dir, 'server.json'), 'utf8'));
    assert.notEqual(instance.port, occupied);
    const base = `http://127.0.0.1:${instance.port}`;
    assert.equal((await fetch(base + '/health').then(r => r.json())).pid, instance.pid);
    const again = await command(); assert.ok(again.stdout.includes(base));
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'server.json'), 'utf8')), instance);
    client = new Client({ name: 'cli-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    const result = await client.callTool({ name: 'create_diagram', arguments: { graph: { title: 'Persistent drawing', nodes: [{ id: 'one', label: 'One' }] } } });
    assert.ok(!result.isError); assert.ok(result.structuredContent.review_url.startsWith(base));
    const diagramId = result.structuredContent.id;
    const ui = await fetch(base).then(r => r.text()); assert.ok(ui.includes('/app.js'));
    const bundle = await fetch(base + '/app.js'); assert.equal(bundle.status, 200);
    assert.ok((await bundle.text()).includes('drawingPoint'));
    await client.close(); client = null;
    process.kill(instance.pid, 'SIGKILL');
    const deadline = Date.now() + 8000;
    while (true) {
      const restarted = JSON.parse(await readFile(join(dir, 'server.json'), 'utf8'));
      if (restarted.pid !== instance.pid) { instance = restarted; break; }
      assert.ok(Date.now() < deadline, 'PM2 did not restart the crashed server.');
      await delay(100);
    }
    assert.equal(instance.port, Number(new URL(base).port));
    assert.equal((await fetch(base + '/api/diagrams').then(r => r.json()))[0].id, diagramId);
    await writeFile(join(dir, 'server.json'), 'corrupt discovery file');
    await command('close');
    await assert.rejects(fetch(base + '/health', { signal: AbortSignal.timeout(1500) }));
    assert.ok((await command('status')).stdout.includes('not running'));
    await command('close');
    await command();
    instance = JSON.parse(await readFile(join(dir, 'server.json'), 'utf8'));
    const drawings = await fetch(`http://127.0.0.1:${instance.port}/api/diagrams`).then(r => r.json());
    assert.equal(drawings[0].id, diagramId);
    assert.ok((await command('--help')).stdout.includes('indri close'));
    await assert.rejects(command('invalid'), /Usage/);
  } finally {
    await client?.close();
    await command('close').catch(() => {});
    await run(process.execPath, [pm2bin, 'kill'], { env, timeout: 10000 }).catch(() => {});
    await new Promise(resolve => blocker.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
