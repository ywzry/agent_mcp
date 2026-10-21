import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { Store } from './core/store.js';
import { SessionManager } from './core/sessions.js';
import { createRunner } from './runtime/runner.js';
import { createServer } from './mcp/server.js';

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  if (configIndex < 0 || !args[configIndex + 1])
    throw new Error('Usage: node dist/index.js --config <yaml-path> [--prune-sessions-before <ISO>] [--prune-artifacts-before <ISO>]');
  const config = loadConfig(args[configIndex + 1]!);

  const sessionsBefore = flagValue(args, '--prune-sessions-before');
  const artifactsBefore = flagValue(args, '--prune-artifacts-before');
  if (sessionsBefore || artifactsBefore) {
    if (!config.defaults.state_dir) throw new Error('PERSISTENCE_DISABLED: state_dir is not configured');
    const store = new Store(config.defaults.state_dir, 'agent-mcp prune');
    try {
      const result = {
        ...(sessionsBefore ? { sessions: store.pruneSessionsBefore(sessionsBefore) } : {}),
        ...(artifactsBefore ? { artifacts: store.pruneArtifactsBefore(artifactsBefore) } : {}),
      };
      console.error(`prune complete: ${JSON.stringify(result)}`);
    } finally {
      store.close();
    }
    return;
  }

  if (args.length !== 2 || args[0] !== '--config')
    throw new Error('Usage: node dist/index.js --config <yaml-path>');
  const manager = new SessionManager(config, createRunner(config));
  const server = createServer(manager);
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    const watchdog = setTimeout(() => process.exit(1), 5000);
    await manager.close(); await server.close(); clearTimeout(watchdog);
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.stdin.once('end', () => { void stop(); });
  await server.connect(new StdioServerTransport());
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires an ISO timestamp`);
  return value;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
