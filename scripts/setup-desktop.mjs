import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { desktopRuntimeDir } from '../dist/runtime/bundled-backends.js';

if (process.platform !== 'win32') throw new Error('The bundled Windows-MCP backend requires Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.AGENT_MCP_UV, 'uv', join(homedir(), '.local', 'bin', 'uv.exe')].filter(Boolean);
const uv = candidates.find(command => spawnSync(command, ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0);
if (!uv) throw new Error('Install uv from https://docs.astral.sh/uv/getting-started/installation/ or set AGENT_MCP_UV to its executable.');
function run(args) {
  const result = spawnSync(uv, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`uv failed (${result.status ?? result.error?.message})`);
}
mkdirSync(desktopRuntimeDir, { recursive: true });
const venv = join(desktopRuntimeDir, '.venv');
const python = join(venv, 'Scripts', 'python.exe');
if (!existsSync(python)) run(['venv', '--python', '3.14.7', venv]);
run(['pip', 'sync', '--python', python, '--require-hashes', resolve(root, 'backends/windows/requirements.lock')]);
console.log('Ready: Windows-MCP 0.8.8 in the project-owned desktop environment. No startup service or host configuration was installed.');
