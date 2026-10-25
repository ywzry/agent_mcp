import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Config, McpServerConfig } from '../config.js';
import type { ArtifactRef, MessageImage, RuntimeDescription } from '../core/types.js';
import type { ModelTool } from './models.js';
import type { DownstreamTools, ToolOutcome } from './tools.js';
import { ownedStdio, type OwnedStdio } from './owned-stdio.js';

interface LoadedServer {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: Map<string, { original: string; definition: ModelTool }>;
  close: () => Promise<boolean>;
}

export class StopUnconfirmedError extends Error {
  readonly code = 'STOP_UNCONFIRMED';
  constructor(scope: string, marker?: string) {
    super(`STOP_UNCONFIRMED: downstream resource ${scope} is quarantined. Confirm the remote operation and all owned processes have stopped before restarting${marker ? ` and deleting ${marker}` : ''}.`);
  }
}

interface Route { server: string; original: string }

interface ConnectParams {
  sessionId: string;
  workspace: string;
  emit: (type: string, message: string, data?: unknown) => void;
  signal: AbortSignal;
  saveArtifact: (input: { name: string; kind: ArtifactRef['kind']; mime?: string; data: string | Buffer }) => ArtifactRef;
}

/**
 * Owns downstream MCP processes for the lifetime of the plugin. Servers marked
 * per_session get one process per session; others are shared. Tool names are
 * namespaced and never expose this plugin's own delegation tools.
 */
export class BackendManager {
  private loaded = new Map<string, Promise<LoadedServer>>();
  private status = new Map<string, RuntimeDescription['backends'][number]>();
  private locks = new Map<string, Mutex>();
  private closed = false;
  private shutdown = new AbortController();
  private quarantined = new Set<string>();
  private inflight = new Map<string, number>();
  private closing?: Promise<void>;
  private retiring = new Map<Promise<boolean>, string>();

  constructor(private config: Config) {
    for (const [name, server] of Object.entries(config.tools.mcp_servers)) {
      this.status.set(name, {
        name, transport: server.transport, connected: false, per_session: server.per_session,
      });
    }
  }

  async toolsForRun(params: ConnectParams): Promise<DownstreamTools> {
    const routes = new Map<string, Route>();
    const loaded: LoadedServer[] = [];
    for (const [name, config] of Object.entries(this.config.tools.mcp_servers)) {
      try {
        const server = await this.get(name, config, params);
        loaded.push(server);
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        // A failing backend can echo authentication values into stderr or its
        // transport error. Redact before exposing status or persisting events.
        const credentialNames = config.transport === 'stdio'
          ? Object.values(config.env_from)
          : config.api_key_env ? [config.api_key_env] : [];
        const secrets = credentialNames.map(key => process.env[key]).filter((value): value is string => Boolean(value));
        for (const value of secrets.sort((a, b) => b.length - a.length))
          message = message.split(value).join('[REDACTED]');
        this.status.set(name, { name, transport: config.transport, connected: false, per_session: config.per_session, error: message });
        params.emit('mcp.connect_failed', `Downstream MCP ${name} is unavailable: ${message}`, { server: name });
        if (params.signal.aborted || this.closed) {
          const safe = new Error(message);
          safe.name = error instanceof Error ? error.name : 'Error';
          throw Object.assign(safe, { code: (error as { code?: string }).code });
        }
      }
    }
    const definitions: ModelTool[] = [];
    for (const server of loaded) {
      // A later failed connection may have quarantined an earlier one's group.
      // Omit that entire scope; independent tools can still serve this run.
      try { this.assertAvailable(this.scope(server.name, server.config)); }
      catch (error) { if (error instanceof StopUnconfirmedError) continue; throw error; }
      for (const [namespaced, tool] of server.tools) {
        routes.set(namespaced, { server: server.name, original: tool.original });
        definitions.push({ ...tool.definition, name: namespaced });
      }
    }
    return {
      definitions: () => definitions,
      call: (name, args, signal) => this.call(routes, name, args, signal, params),
    };
  }

  describe(): RuntimeDescription['backends'] {
    return [...this.status.values()].map(value => ({ ...value }));
  }

  async close(): Promise<void> {
    return this.closing ??= this.closeAll();
  }

  private async closeAll(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    const values = [...this.loaded.values()];
    this.loaded.clear();
    await Promise.all(values.map(async promise => {
      try {
        const server = await promise;
        if (!await server.close() && (server.config.transport === 'stdio' || this.inflight.has(this.scope(server.name, server.config))))
          this.quarantine(this.scope(server.name, server.config));
      } catch { /* connect/call failure owns its quarantine */ }
    }));
    await Promise.all([...this.retiring.keys()]);
  }

  private async get(name: string, config: McpServerConfig, params: ConnectParams): Promise<LoadedServer> {
    const scope = this.scope(name, config);
    // Connecting a replacement may itself have effects. All clients in this
    // resource scope must wait for retirement, not only tools/call mutex owners.
    for (;;) {
      const pending = [...this.retiring].filter(([, resource]) => resource === scope).map(([promise]) => promise);
      if (!pending.length) break;
      await Promise.all(pending);
    }
    if (this.closed) throw new Error('BACKEND_MANAGER_CLOSED');
    this.assertAvailable(scope);
    const key = config.per_session ? `${name}::${params.sessionId}` : name;
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const promise = this.connect(name, config, { ...params, signal: AbortSignal.any([params.signal, this.shutdown.signal]) }).catch(error => {
      if (this.loaded.get(key) === promise) this.loaded.delete(key);
      throw error;
    });
    this.loaded.set(key, promise);
    return promise;
  }

  private async connect(name: string, config: McpServerConfig, params: ConnectParams): Promise<LoadedServer> {
    params.signal.throwIfAborted();
    let stderr = '';
    let transport;
    let owned: OwnedStdio | undefined;
    if (config.transport === 'stdio') {
      const env = { ...getDefaultEnvironment(), ...config.env };
      for (const [child, parent] of Object.entries(config.env_from)) {
        const value = process.env[parent];
        if (!value) throw new Error(`BACKEND_ENV_MISSING: ${name} requires environment variable ${parent}`);
        env[child] = value;
      }
      transport = owned = ownedStdio({
        command: config.command, args: config.args, env, cwd: config.cwd, stderr: 'pipe',
      });
      transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    } else {
      const headers: Record<string, string> = { ...config.headers };
      if (config.api_key_env) {
        const value = process.env[config.api_key_env];
        if (!value) throw new Error(`BACKEND_ENV_MISSING: ${name} requires environment variable ${config.api_key_env}`);
        headers.authorization = `Bearer ${value}`;
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    }
    const client = new Client({ name: 'agent-mcp-downstream', version: '0.1.0' });
    let stopping: Promise<boolean> | undefined;
    const close = (): Promise<boolean> => {
      if (stopping) return stopping;
      stopping = (async () => {
        // Keep ownership visible until cleanup and quarantine decisions finish.
        const key = config.per_session ? `${name}::${params.sessionId}` : name;
        const confirmed = owned ? await owned.stop().catch(() => false) : false;
        try { await client.close(); } catch { /* local connection may already be gone */ }
        this.status.set(name, { name, transport: config.transport, connected: false, per_session: config.per_session });
        if (!confirmed && (owned || this.inflight.has(this.scope(name, config)))) this.quarantine(this.scope(name, config));
        this.loaded.delete(key);
        return confirmed;
      })();
      this.retiring.set(stopping, this.scope(name, config));
      void stopping.finally(() => this.retiring.delete(stopping!)).catch(() => {});
      return stopping;
    };
    try {
      await withTimeout(
        client.connect(transport, { timeout: config.timeout_ms, signal: params.signal }),
        config.timeout_ms, `MCP_CONNECT_TIMEOUT ${name}`,
      );
      const listing = await withTimeout(client.listTools(undefined, { timeout: config.timeout_ms, signal: params.signal }), config.timeout_ms, `MCP_LIST_TIMEOUT ${name}`);
      const tools = new Map<string, { original: string; definition: ModelTool }>();
      for (const tool of listing.tools) {
        if (!tool.name || tool.name.startsWith('agent_')) continue;
        const namespaced = `${name}__${tool.name}`;
        tools.set(namespaced, {
          original: tool.name,
          definition: {
            name: namespaced,
            description: `[${name}] ${tool.description ?? tool.name}`,
            input_schema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          },
        });
      }
      this.status.set(name, { name, transport: config.transport, connected: true, per_session: config.per_session });
      params.emit('mcp.connected', `Connected to ${name} (${tools.size} tools).`, { server: name, tools: tools.size });
      return {
        name, config, client, tools,
        close,
      };
    } catch (error) {
      const confirmed = await close();
      const detail = stderr ? `: ${stderr.slice(-2000)}` : '';
      if (!confirmed && (owned || params.signal.aborted || /TIMEOUT|timed out/i.test(String(error)))) {
        this.quarantine(this.scope(name, config));
        const failure = new StopUnconfirmedError(this.scope(name, config), this.marker(this.scope(name, config)));
        failure.message += detail;
        throw failure;
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
    }
  }

  private async call(
    routes: Map<string, Route>, name: string,
    args: Record<string, unknown>, signal: AbortSignal, params: ConnectParams,
  ): Promise<ToolOutcome> {
    const route = routes.get(name);
    if (!route) throw new Error(`UNKNOWN_TOOL: ${name}`);
    const config = this.config.tools.mcp_servers[route.server];
    if (!config) throw new Error(`BACKEND_NOT_CONNECTED: ${route.server}`);
    const scope = this.scope(route.server, config);
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    this.assertAvailable(scope);
    // A shared client always has one owner, even with serial=false. Independent
    // per-session clients remain independent unless they share an exclusive group.
    const instance = config.per_session ? `${route.server}::${params.sessionId}` : route.server;
    const lockKey = config.serial || config.exclusive_group ? scope : `instance:${instance}`;
    const release = await this.lock(lockKey, signal, params.emit);
    try {
      this.assertAvailable(scope);
      if (signal.aborted) throw abortError();
      const server = await this.get(route.server, config, { ...params, signal });
      params.emit('mcp.call.started', `Calling ${route.server}.${route.original}.`, { server: route.server, tool: route.original });
      // A crash or failed stop leaves the marker in place. Reconnection is not
      // evidence that an outstanding remote operation stopped.
      this.writeMarker(scope);
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        result = await server.client.callTool(
          { name: route.original, arguments: args },
          { signal, timeout: server.config.timeout_ms, resetTimeoutOnProgress: true },
        );
        if (signal.aborted) throw abortError();
        this.assertAvailable(scope);
      } catch (error) {
        const confirmed = await server.close();
        if (!confirmed) {
          this.quarantine(scope);
          params.emit('mcp.stop_unconfirmed', `Downstream resource ${scope} quarantined.`, { scope });
          throw new StopUnconfirmedError(scope, this.marker(scope));
        }
        this.clearMarker(scope);
        throw error;
      }
      this.clearMarker(scope);
      params.emit('mcp.call.finished', `${route.server}.${route.original} returned${result.isError ? ' an error' : ''}.`, {
        server: route.server, tool: route.original, is_error: Boolean(result.isError),
      });
      return this.convert(route, result, args, params);
    } finally {
      release();
    }
  }

  private scope(name: string, config: McpServerConfig): string {
    // Quarantine all sessions of a backend: a remote service may share resources
    // even when its local client is per_session.
    return config.exclusive_group ? `group:${config.exclusive_group}` : `backend:${name}`;
  }

  private marker(scope: string): string | undefined {
    return this.config.defaults.state_dir ? join(this.config.defaults.state_dir, 'backend-quarantine', `${createHash('sha256').update(scope).digest('hex')}.json`) : undefined;
  }

  private assertAvailable(scope: string): void {
    const marker = this.marker(scope);
    if (this.quarantined.has(scope) || !this.inflight.has(scope) && marker && existsSync(marker)) throw new StopUnconfirmedError(scope, marker);
  }

  private writeMarker(scope: string): void {
    const count = this.inflight.get(scope) ?? 0;
    if (count) { this.inflight.set(scope, count + 1); return; }
    const marker = this.marker(scope);
    if (marker) {
      mkdirSync(join(this.config.defaults.state_dir!, 'backend-quarantine'), { recursive: true });
      writeFileSync(marker, JSON.stringify({ scope, created_at: new Date().toISOString(), reason: 'operation outstanding; stop not yet confirmed', recovery: 'Confirm all remote effects and owned processes stopped, shut down the plugin, then delete this marker.' }), { flag: 'wx' });
    }
    this.inflight.set(scope, 1);
  }

  private clearMarker(scope: string): void {
    const count = this.inflight.get(scope) ?? 0;
    if (count > 1) { this.inflight.set(scope, count - 1); return; }
    this.inflight.delete(scope);
    if (this.quarantined.has(scope)) return;
    const marker = this.marker(scope);
    if (marker && existsSync(marker)) unlinkSync(marker);
  }

  private quarantine(scope: string): void {
    this.quarantined.add(scope);
    const marker = this.marker(scope);
    for (const [name, server] of Object.entries(this.config.tools.mcp_servers)) {
      if (this.scope(name, server) === scope)
        this.status.set(name, { name, transport: server.transport, connected: false, per_session: server.per_session,
          error: new StopUnconfirmedError(scope, marker).message });
    }
    if (!marker || existsSync(marker)) return;
    this.writeMarker(scope);
  }

  private convert(
    route: Route,
    result: Awaited<ReturnType<Client['callTool']>>,
    args: Record<string, unknown>,
    params: ConnectParams,
  ): ToolOutcome {
    const texts: string[] = [];
    const images: MessageImage[] = [];
    const artifacts: ArtifactRef[] = [];
    for (const item of result.content ?? []) {
      if (item.type === 'text') texts.push(item.text);
      else if (item.type === 'image') {
        const data = Buffer.from(item.data, 'base64');
        const ref = params.saveArtifact({
          name: `${route.server}-${route.original}-${Date.now()}.${extension(item.mimeType)}`,
          kind: 'image', mime: item.mimeType, data,
        });
        artifacts.push(ref);
        if (data.length <= 2 * 1024 * 1024) images.push({ media_type: item.mimeType, data: item.data });
        else texts.push(`[image ${ref.id} is ${data.length} bytes; too large to inline]`);
      } else if (item.type === 'audio') {
        const ref = params.saveArtifact({
          name: `${route.server}-${route.original}-${Date.now()}.audio`, kind: 'file', mime: item.mimeType,
          data: Buffer.from(item.data, 'base64'),
        });
        artifacts.push(ref);
        texts.push(`[audio artifact ${ref.id}]`);
      } else if (item.type === 'resource') {
        const resource = item.resource;
        if ('text' in resource && typeof resource.text === 'string') texts.push(resource.text);
        else if ('blob' in resource && typeof resource.blob === 'string') {
          const ref = params.saveArtifact({
            name: `${route.server}-${route.original}-${Date.now()}.resource`,
            kind: 'file', mime: resource.mimeType ?? 'application/octet-stream',
            data: Buffer.from(resource.blob, 'base64'),
          });
          artifacts.push(ref);
          texts.push(`[resource artifact ${ref.id}]`);
        }
      }
    }
    if (result.structuredContent !== undefined)
      texts.push(`[structuredContent]\n${JSON.stringify(result.structuredContent)}`);
    // Some downstream tools (e.g. take_screenshot with filePath) save output
    // to a file instead of returning a content block. Deliver files that were
    // explicitly requested inside the session workspace as artifacts.
    const outputFile = typeof args.filePath === 'string' ? args.filePath : undefined;
    if (outputFile) {
      const captured = captureWorkspaceFile(outputFile, params.workspace);
      if (captured) {
        const ref = params.saveArtifact({
          name: captured.name, kind: captured.kind, mime: captured.mime, data: captured.data,
        });
        artifacts.push(ref);
        texts.push(`[file artifact ${ref.id}: ${captured.name}, ${captured.data.length} bytes]`);
      }
    }
    let content = texts.join('\n') || '(empty result)';
    if (Buffer.byteLength(content) > this.config.defaults.max_tool_output_bytes) {
      const ref = params.saveArtifact({
        name: `${route.server}-${route.original}-${Date.now()}.txt`, kind: 'text', data: content,
      });
      artifacts.push(ref);
      content = `${content.slice(0, this.config.defaults.max_tool_output_bytes)}\n[truncated; full output artifact ${ref.id}]`;
    }
    return { content, is_error: result.isError === true, ...(images.length ? { images } : {}), artifacts };
  }

  private lock(key: string, signal: AbortSignal, emit: ConnectParams['emit']): Promise<() => void> {
    let mutex = this.locks.get(key);
    if (!mutex) { mutex = new Mutex(); this.locks.set(key, mutex); }
    emit('mcp.exclusive.wait', `Waiting for exclusive resource group ${key}.`, { group: key });
    return mutex.acquire(signal);
  }
}

class Mutex {
  private locked = false;
  private waiters: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; onAbort: () => void }> = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve, reject, signal,
        onAbort: () => {
          this.waiters = this.waiters.filter(item => item !== waiter);
          reject(abortError());
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) { this.locked = false; return; }
      next.signal.removeEventListener('abort', next.onAbort);
      next.resolve(this.releaser());
    };
  }
}

function captureWorkspaceFile(
  requested: string, workspace: string,
): { name: string; kind: ArtifactRef['kind']; mime: string; data: Buffer } | undefined {
  try {
    const root = realpathSync(workspace);
    const target = realpathSync(isAbsolute(requested) ? requested : resolve(workspace, requested));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return undefined;
    const ext = extname(target).toLowerCase();
    const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    return {
      name: rel.replaceAll('\\', '/'),
      kind: image ? 'image' : ext === '.txt' || ext === '.log' || ext === '.json' ? 'text' : 'file',
      mime: image
        ? ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
        : ext === '.json' ? 'application/json' : 'text/plain; charset=utf-8',
      data: readFileSync(target),
    };
  } catch {
    return undefined;
  }
}

function extension(mime: string): string {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortError(): Error {
  const error = new Error('ABORTED');
  error.name = 'AbortError';
  return error;
}
