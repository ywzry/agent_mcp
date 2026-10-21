import {
  existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Config } from '../config.js';
import type { ArtifactRef, CommandEvidence, MessageImage } from '../core/types.js';
import type { ModelTool } from './models.js';
import type { FileChange } from './diff.js';
import { runCommand } from './process.js';
import { readSkillBody, type SkillInfo } from './skills.js';

export interface ToolOutcome {
  content: string;
  is_error?: boolean;
  images?: MessageImage[];
  change?: FileChange;
  command?: CommandEvidence;
  artifacts?: ArtifactRef[];
}

export interface DownstreamTools {
  definitions(): ModelTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface ToolRegistryOptions {
  config: Config;
  workspace: string;
  signal: AbortSignal;
  skills: readonly SkillInfo[];
  downstream?: DownstreamTools;
  saveArtifact: (input: { name: string; kind: ArtifactRef['kind']; mime?: string; data: string | Buffer }) => ArtifactRef;
  emit: (type: string, message: string, data?: unknown) => void;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;

export class ToolRegistry {
  private definitions = new Map<string, ModelTool>();
  private skills = new Map<string, SkillInfo>();
  private downstreamNames = new Set<string>();
  private workspaceReal: string;
  private commandEnv: NodeJS.ProcessEnv;

  constructor(private options: ToolRegistryOptions) {
    this.workspaceReal = realpathSync(options.workspace);
    this.commandEnv = commandEnvironment(options.config);
    for (const name of options.config.tools.builtin) this.addBuiltin(name);
    for (const skill of options.skills) this.skills.set(skill.name, skill);
    if (options.skills.length) {
      this.definitions.set('skill_list', {
        name: 'skill_list',
        description: 'List available skill names, descriptions and paths. Skills add instructions only; they never grant tools or permissions.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
      });
      this.definitions.set('skill_read', {
        name: 'skill_read',
        description: 'Read one skill body by name. Skills are instructions, not permissions.',
        input_schema: {
          type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false,
        },
      });
    }
    for (const definition of options.downstream?.definitions() ?? []) {
      if (this.definitions.has(definition.name)) continue;
      this.definitions.set(definition.name, definition);
      this.downstreamNames.add(definition.name);
    }
  }

  list(): ModelTool[] { return [...this.definitions.values()]; }

  async call(name: string, rawArgs: unknown): Promise<ToolOutcome> {
    if (this.options.signal.aborted) throw abortError();
    const args = asArgs(rawArgs);
    if (this.downstreamNames.has(name)) {
      const outcome = await this.options.downstream!.call(name, args, this.options.signal);
      if (this.options.signal.aborted) throw abortError();
      return outcome;
    }
    switch (name) {
      case 'read_file': return this.read(args);
      case 'write_file': return this.write(args);
      case 'edit_file': return this.edit(args);
      case 'exec_command': return this.exec(args);
      case 'skill_list': return { content: JSON.stringify([...this.skills.values()].map(skill => ({
        name: skill.name, description: skill.description, path: skill.path, tokens_estimate: skill.tokens_estimate,
      })), null, 2) };
      case 'skill_read': return this.skillRead(args);
      default: throw new Error(`UNKNOWN_TOOL: ${name}`);
    }
  }

  private addBuiltin(name: 'read' | 'write' | 'edit' | 'exec') {
    if (name === 'read') this.definitions.set('read_file', {
      name: 'read_file',
      description: 'Read a text file inside the workspace. Returns numbered lines. Large output is saved as an artifact and truncated.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace' },
          offset: { type: 'integer', minimum: 0, description: 'Zero-based starting line' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum lines' },
        },
        required: ['path'], additionalProperties: false,
      },
    });
    if (name === 'write') this.definitions.set('write_file', {
      name: 'write_file',
      description: 'Write a complete text file inside the workspace, creating parent directories. Returns a unified diff.',
      input_schema: {
        type: 'object', properties: {
          path: { type: 'string' }, content: { type: 'string' },
        }, required: ['path', 'content'], additionalProperties: false,
      },
    });
    if (name === 'edit') this.definitions.set('edit_file', {
      name: 'edit_file',
      description: 'Replace an exact string in a workspace file. By default old_string must occur exactly once. Returns a unified diff.',
      input_schema: {
        type: 'object', properties: {
          path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one' },
        }, required: ['path', 'old_string', 'new_string'], additionalProperties: false,
      },
    });
    if (name === 'exec') this.definitions.set('exec_command', {
      name: 'exec_command',
      description: 'Run a shell command in the workspace (or a subdirectory) with a timeout. The process tree is killed on timeout/cancel. Output is truncated after the configured limit.',
      input_schema: {
        type: 'object', properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Optional workspace-relative working directory' },
          timeout_ms: { type: 'integer', minimum: 1, description: 'Must not exceed the configured execution limit' },
        }, required: ['command'], additionalProperties: false,
      },
    });
  }

  private read(args: Record<string, unknown>): ToolOutcome {
    const target = this.resolvePath(stringArg(args, 'path'), 'read');
    const stat = statSync(target);
    if (stat.isDirectory()) throw new Error('TOOL_ARGUMENT_INVALID: path is a directory');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`FILE_TOO_LARGE: ${stat.size} bytes; maximum ${MAX_FILE_BYTES}`);
    const buffer = readFileSync(target);
    if (buffer.subarray(0, 8192).includes(0)) {
      const artifact = this.options.saveArtifact({
        name: relative(this.options.workspace, target).replaceAll('\\', '/'),
        kind: 'file', mime: 'application/octet-stream', data: buffer,
      }).id;
      return { content: `Binary file (${buffer.length} bytes). Artifact ${artifact}.` };
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    const offset = intArg(args, 'offset', 0);
    const limit = intArg(args, 'limit', 2000);
    const selected = lines.slice(offset, offset + limit);
    const numbered = selected.map((line, index) => `${offset + index + 1}\t${line}`).join('\n');
    return this.cap(`[${relative(this.options.workspace, target)}] ${lines.length} lines\n${numbered}`, 'read', target);
  }

  private write(args: Record<string, unknown>): ToolOutcome {
    const target = this.resolvePath(stringArg(args, 'path'), 'write');
    const content = stringArg(args, 'content', true);
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error(`FILE_TOO_LARGE: write exceeds ${MAX_WRITE_BYTES} bytes`);
    const before = existsSync(target) && statSync(target).isFile() && statSync(target).size <= MAX_FILE_BYTES
      ? readFileSync(target, 'utf8') : null;
    mkdirSync(dirname(target), { recursive: true });
    this.assertRealParent(dirname(target));
    writeFileSync(target, content, 'utf8');
    const path = relative(this.options.workspace, target).replaceAll('\\', '/');
    return {
      content: `Wrote ${Buffer.byteLength(content)} bytes to ${path}.`,
      change: { path, before, after: content },
    };
  }

  private edit(args: Record<string, unknown>): ToolOutcome {
    const target = this.resolvePath(stringArg(args, 'path'), 'write');
    if (!existsSync(target)) throw new Error('FILE_NOT_FOUND');
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error('TOOL_ARGUMENT_INVALID: path is not a file');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`FILE_TOO_LARGE: ${stat.size} bytes`);
    const before = readFileSync(target, 'utf8');
    const oldString = stringArg(args, 'old_string');
    const newString = stringArg(args, 'new_string', true);
    if (!oldString) throw new Error('TOOL_ARGUMENT_INVALID: old_string must not be empty');
    const count = before.split(oldString).length - 1;
    if (count === 0) throw new Error('EDIT_NOT_APPLIED: old_string not found');
    const replaceAll = args.replace_all === true;
    if (!replaceAll && count !== 1) throw new Error(`EDIT_NOT_UNIQUE: old_string occurs ${count} times; pass replace_all or a unique context`);
    const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
    this.assertRealParent(dirname(target));
    writeFileSync(target, after, 'utf8');
    const path = relative(this.options.workspace, target).replaceAll('\\', '/');
    return {
      content: `Edited ${path}: replaced ${replaceAll ? count : 1} occurrence(s).`,
      change: { path, before, after },
    };
  }

  private async exec(args: Record<string, unknown>): Promise<ToolOutcome> {
    const command = stringArg(args, 'command');
    const cwdArg = args.cwd === undefined ? '.' : stringArg(args, 'cwd');
    const cwd = this.resolvePath(cwdArg, 'read');
    if (!statSync(cwd).isDirectory()) throw new Error('TOOL_ARGUMENT_INVALID: cwd is not a directory');
    const requested = args.timeout_ms === undefined ? this.options.config.defaults.exec_timeout_ms : intArg(args, 'timeout_ms', this.options.config.defaults.exec_timeout_ms);
    const timeoutMs = Math.min(Math.max(1, requested), this.options.config.defaults.exec_timeout_ms);
    const capture = Math.min(Math.max(this.options.config.defaults.max_tool_output_bytes * 10, 2 * 1024 * 1024), 8 * 1024 * 1024);
    this.options.emit('tool.exec.started', `Running command (timeout ${timeoutMs} ms).`, { command, cwd });
    const result = await runCommand({
      command, cwd, timeoutMs, maxBytes: capture, signal: this.options.signal, env: this.commandEnv,
    });
    const combined = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ''].filter(Boolean).join('\n');
    const header = `exit_code=${String(result.exit_code)} signal=${String(result.signal)} timed_out=${result.timed_out} duration_ms=${result.duration_ms} cleanup_unconfirmed=${result.cleanup_unconfirmed}`;
    if (result.cleanup_unconfirmed)
      this.options.emit('tool.exec.cleanup_unconfirmed', 'Process reaper fallback fired before child exit was confirmed.', { command });
    let outputArtifact: string | undefined;
    let body = combined;
    const maxOutputBytes = this.options.config.defaults.max_tool_output_bytes;
    if (Buffer.byteLength(combined) > maxOutputBytes) {
      outputArtifact = this.options.saveArtifact({
        name: `command-output-${Date.now()}.log`, kind: 'text', data: combined,
      }).id;
      body = `${Buffer.from(combined).subarray(0, maxOutputBytes).toString('utf8')}\n[truncated; full output artifact ${outputArtifact}]`;
    }
    if (result.truncated) body += '\n[capture limit reached; later output was discarded]';
    this.options.emit('tool.exec.finished', `Command finished with exit code ${String(result.exit_code)}.`, {
      exit_code: result.exit_code, timed_out: result.timed_out, output_artifact: outputArtifact,
      cleanup_unconfirmed: result.cleanup_unconfirmed,
    });
    return {
      content: `${header}\n${body}`,
      is_error: result.exit_code !== 0 || result.timed_out || result.cleanup_unconfirmed,
      command: {
        command, exit_code: result.exit_code, timed_out: result.timed_out,
        output_artifact: outputArtifact, cleanup_unconfirmed: result.cleanup_unconfirmed,
      },
    };
  }

  private skillRead(args: Record<string, unknown>): ToolOutcome {
    const name = stringArg(args, 'name');
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`SKILL_NOT_FOUND: ${name}`);
    return this.cap(
      `Skill ${skill.name}\nPath: ${skill.path}\nThis content is instructions only; configured tools and OS permissions still apply.\n\n${readSkillBody(skill)}`,
      'skill', skill.path,
    );
  }

  private cap(content: string, label: string, sourcePath: string): ToolOutcome {
    const maxBytes = this.options.config.defaults.max_tool_output_bytes;
    const bytes = Buffer.from(content);
    if (bytes.length <= maxBytes) return { content };
    const artifact = this.options.saveArtifact({
      name: `${label}-${relative(this.options.workspace, sourcePath).replaceAll('\\', '/')}`,
      kind: 'text', data: content,
    });
    return {
      content: `${bytes.subarray(0, maxBytes).toString('utf8')}\n[truncated; full content artifact ${artifact.id}]`,
      artifacts: [artifact],
    };
  }

  private resolvePath(input: string, mode: 'read' | 'write'): string {
    if (!input || input.includes('\u0000')) throw new Error('TOOL_ARGUMENT_INVALID: invalid path');
    const target = isAbsolute(input) ? resolve(input) : resolve(this.options.workspace, input);
    if (!inside(this.workspaceReal, target)) throw new Error(`WORKSPACE_ESCAPE: ${input}`);
    let existing = target;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const real = realpathSync(existing);
    if (!inside(this.workspaceReal, real)) throw new Error(`WORKSPACE_ESCAPE: ${input} resolves outside the workspace`);
    if (mode === 'read' && !existsSync(target)) throw new Error('FILE_NOT_FOUND');
    return target;
  }

  private assertRealParent(parent: string) {
    const real = realpathSync(parent);
    if (!inside(this.workspaceReal, real)) throw new Error('WORKSPACE_ESCAPE: parent resolves outside the workspace');
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`) || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function asArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TOOL_ARGUMENT_INVALID: arguments must be an object');
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`TOOL_ARGUMENT_INVALID: ${key} must be a non-empty string`);
  return value;
}

function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`TOOL_ARGUMENT_INVALID: ${key} must be a non-negative integer`);
  return value;
}

function abortError(): Error {
  const error = new Error('ABORTED');
  error.name = 'AbortError';
  return error;
}

/**
 * Shell tools inherit OS permissions but not the plugin's credential
 * environment. Credentials that the plugin needs for model/downstream auth are
 * removed by the variable names declared in config.
 */
function commandEnvironment(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const provider of Object.values(config.providers))
    if (provider.api_key_env) delete env[provider.api_key_env];
  for (const server of Object.values(config.tools.mcp_servers)) {
    if (server.transport === 'http' && server.api_key_env) delete env[server.api_key_env];
    if (server.transport === 'stdio')
      for (const parent of Object.values(server.env_from)) delete env[parent];
  }
  return env;
}
