import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export function macStartup(node, pm2, pm2Home) {
  const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.indri.local</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(pm2)}</string><string>resurrect</string></array>
<key>EnvironmentVariables</key><dict><key>PM2_HOME</key><string>${xml(pm2Home)}</string><key>PATH</key><string>${xml(dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>${xml(join(pm2Home, 'startup.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(pm2Home, 'startup-error.log'))}</string>
</dict></plist>\n`;
}

export async function installStartup(dataDir, pm2Bin) {
  // shortcut: automatic login startup is macOS/default-profile only; add OS adapters when tested on other platforms.
  if (process.platform !== 'darwin' || dataDir !== resolve(homedir(), '.indri')) return;
  const file = join(homedir(), 'Library/LaunchAgents/com.indri.local.plist');
  const contents = macStartup(process.execPath, pm2Bin, join(dataDir, 'pm2'));
  const old = await readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (old === contents) return;
  await mkdir(dirname(file), { recursive: true });
  if (old) await run('launchctl', ['bootout', `gui/${process.getuid()}`, file]).catch(() => {});
  await writeFile(file, contents, { mode: 0o600 });
  await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
}
