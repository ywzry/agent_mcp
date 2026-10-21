import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '../config.js';

export const desktopRuntimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../.agent-mcp/backends/windows');

/** Presets become ordinary downstream MCP connections; there is no second runner. */
export function resolveBundledBackends(
  bundled: { browser?: boolean; desktop?: boolean } | undefined,
  custom: Record<string, McpServerConfig>,
  runtime: { platform?: NodeJS.Platform; runtime?: string; workspace?: string } = {},
): Record<string, McpServerConfig> {
  const servers = { ...custom };
  for (const name of ['browser', 'desktop'] as const) {
    if (bundled?.[name] && servers[name]) throw new Error(`BUNDLED_BACKEND_CONFLICT: ${name} is also configured in mcp_servers`);
  }
  if (bundled?.browser) {
    const manifest = createRequire(import.meta.url).resolve('chrome-devtools-mcp/package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> };
    servers.browser = {
      transport: 'stdio', command: process.execPath,
      args: [resolve(dirname(manifest), pkg.bin['chrome-devtools-mcp']!), '--isolated', '--no-usage-statistics', '--no-performance-crux',
        `--filesystem-root=${resolve(runtime.workspace ?? process.cwd())}`],
      env: {}, env_from: {}, serial: false, per_session: true, timeout_ms: 60_000,
    };
  }
  if (bundled?.desktop) {
    if ((runtime.platform ?? process.platform) !== 'win32') throw new Error('WINDOWS_ONLY: bundled desktop currently supports Windows; configure a custom MCP backend on other systems');
    const python = join(runtime.runtime ?? desktopRuntimeDir, '.venv', 'Scripts', 'python.exe');
    if (!existsSync(python)) throw new Error('Desktop backend not installed. Run npm run setup:desktop first.');
    servers.desktop = {
      transport: 'stdio', command: python,
      args: ['-m', 'windows_mcp', 'serve', '--transport', 'stdio', '--config', resolve(dirname(fileURLToPath(import.meta.url)), '../../backends/windows/config.toml')],
      env: {
        ANONYMIZED_TELEMETRY: 'false', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        WINDOWS_MCP_TOOLS: 'App,Snapshot,Screenshot,Click,Type,Scroll,Move,Shortcut,Wait,WaitFor,DisplayInventory',
      }, env_from: {},
      serial: true, exclusive_group: 'desktop', per_session: false, timeout_ms: 60_000,
    };
  }
  return servers;
}
