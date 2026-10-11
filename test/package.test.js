import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('published tarball installs without build tools and runs from another directory', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indri-package-'));
  const prefix = join(dir, 'install'), data = join(dir, 'state');
  const env = { ...process.env, INDRI_DATA_DIR: data, PM2_HOME: join(data, 'pm2') };
  const bin = join(prefix, 'bin/indri');
  let installed = false;
  try {
    const pack = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir])).stdout)[0];
    const files = pack.files.map(f => f.path);
    for (const file of ['bin/indri.js', 'public/app.js', 'npm-shrinkwrap.json']) assert.ok(files.includes(file));
    assert.ok(files.every(f => !/^(data|test)\//.test(f) && !f.endsWith('.sqlite')));
    assert.ok(!files.some(f => /^node_modules\/(esbuild|@playwright)\//.test(f)));
    await run('npm', ['install', '-g', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(dir, pack.filename)], { timeout: 60000 });
    installed = true;
    const start = await run(bin, [], { env, cwd: dir, timeout: 20000 });
    const instance = JSON.parse(await readFile(join(data, 'server.json'), 'utf8'));
    const base = `http://127.0.0.1:${instance.port}`;
    assert.ok(start.stdout.includes(base));
    assert.equal((await fetch(base + '/health').then(r => r.json())).pid, instance.pid);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.ok((await run(bin, ['status'], { env, cwd: dir })).stdout.includes(base));
    const require = createRequire(join(prefix, 'lib/node_modules/indri/package.json'));
    assert.throws(() => require.resolve('esbuild'));
    const watcher = JSON.parse(await readFile(join(dirname(require.resolve('chokidar')), 'package.json'), 'utf8'));
    assert.equal(watcher.version.split('.')[0], '4');
    assert.throws(() => require.resolve('braces'));
    await run(bin, ['close'], { env, cwd: dir });
    await assert.rejects(fetch(base + '/health', { signal: AbortSignal.timeout(1500) }));
  } finally {
    if (installed) {
      await run(bin, ['close'], { env, timeout: 10000 }).catch(() => {});
      const require = createRequire(join(prefix, 'lib/node_modules/indri/package.json'));
      await run(process.execPath, [require.resolve('pm2/bin/pm2'), 'kill'], { env, timeout: 10000 }).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  }
});
