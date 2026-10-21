import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Config, McpServerConfig } from '../config.js';
import type { ArtifactRef, MessageImage, RuntimeDescription } from '../core/types.js';
import type { ModelTool } from './models.js';
import type { DownstreamTools, ToolOutcome } from './tools.js';

interface LoadedServer {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: Map<string, { original: string; definition: ModelTool }>;
  close: () => Promise<void>;
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
        for (const [namespaced, tool] of server.tools) routes.set(namespaced, { server: name, original: tool.original });
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
      }
    }
    const definitions: ModelTool[] = [];
    for (const server of loaded)
      for (const [namespaced, tool] of server.tools) definitions.push({ ...tool.definition, name: namespaced });
    return {
      definitions: () => definitions,
      call: (name, args, signal) => this.call(routes, loaded, name, args, signal, params),
    };
  }

  describe(): RuntimeDescription['backends'] {
    return [...this.status.values()].map(value => ({ ...value }));
  }

  async close(): Promise<void> {
    this.closed = true;
    const values = [...this.loaded.values()];
    this.loaded.clear();
    await Promise.all(values.map(async promise => {
      try { const server = await promise; await server.close(); } catch { /* failed connects own nothing */ }
    }));
  }

  private async get(name: string, config: McpServerConfig, params: ConnectParams): Promise<LoadedServer> {
    if (this.closed) throw new Error('BACKEND_MANAGER_CLOSED');
    const key = config.per_session ? `${name}::${params.sessionId}` : name;
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const promise = this.connect(name, config, params).catch(error => {
      this.loaded.delete(key);
      throw error;
    });
    this.loaded.set(key, promise);
    return promise;
  }

  private async connect(name: string, config: McpServerConfig, params: ConnectParams): Promise<LoadedServer> {
    params.signal.throwIfAborted();
    let stderr = '';
    let transport;
    if (config.transport === 'stdio') {
      const env = { ...getDefaultEnvironment(), ...config.env };
      for (const [child, parent] of Object.entries(config.env_from)) {
        const value = process.env[parent];
        if (!value) throw new Error(`BACKEND_ENV_MISSING: ${name} requires environment variable ${parent}`);
        env[child] = value;
      }
      transport = new StdioClientTransport({
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
        close: async () => { try { await client.close(); } catch { /* transport already gone */ } },
      };
    } catch (error) {
      try { await client.close(); } catch { /* best effort */ }
      const detail = stderr ? `: ${stderr.slice(-2000)}` : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
    }
  }

  private async call(
    routes: Map<string, Route>, loaded: LoadedServer[], name: string,
    args: Record<string, unknown>, signal: AbortSignal, params: ConnectParams,
  ): Promise<ToolOutcome> {
    const route = routes.get(name);
    if (!route) throw new Error(`UNKNOWN_TOOL: ${name}`);
    const server = loaded.find(item => item.name === route.server);
    if (!server) throw new Error(`BACKEND_NOT_CONNECTED: ${route.server}`);
    const lockKey = server.config.serial ? (server.config.exclusive_group ?? route.server) : undefined;
    const release = lockKey ? await this.lock(lockKey, signal, params.emit) : undefined;
    try {
      if (signal.aborted) throw abortError();
      params.emit('mcp.call.started', `Calling ${route.server}.${route.original}.`, { server: route.server, tool: route.original });
      const result = await server.client.callTool(
        { name: route.original, arguments: args },
        { signal, timeout: server.config.timeout_ms, resetTimeoutOnProgress: true },
      );
      params.emit('mcp.call.finished', `${route.server}.${route.original} returned${result.isError ? ' an error' : ''}.`, {
        server: route.server, tool: route.original, is_error: Boolean(result.isError),
      });
      return this.convert(route, result, args, params);
    } finally {
      release?.();
    }
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
