import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { resolveBundledBackends } from './runtime/bundled-backends.js';

const positive = z.number().int().positive();
export const reasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

const protocol = z.enum(['demo', 'openai_responses', 'openai_chat_completions', 'anthropic']);
const providerSchema = z.object({
  protocol,
  base_url: z.url().optional(),
  /** Name of the environment variable holding the key; never the key itself. */
  api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  /** Optional auth header override, e.g. x-api-key for some compatible gateways. */
  api_key_header: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
  /** Optional auth value prefix, e.g. "Bearer" or "" for a raw key. */
  api_key_prefix: z.string().max(40).optional(),
  /** Extra non-secret headers. Do not put credentials here. */
  headers: z.record(z.string(), z.string()).default({}),
}).strict().superRefine((p, ctx) => {
  if (p.protocol !== 'demo') {
    if (!p.base_url) ctx.addIssue({ code: 'custom', message: 'real protocol requires base_url' });
    if (!p.api_key_env) ctx.addIssue({ code: 'custom', message: 'real protocol requires api_key_env' });
  }
});

export const modelSchema = z.object({
  provider: z.string().min(1),
  model_id: z.string().min(1),
  description: z.string().default(''),
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean() }).strict(),
  reasoning: z.object({
    effort: z.enum(reasoningEfforts).optional(),
    budget_tokens: positive.optional(),
  }).strict(),
  context: z.object({
    window_tokens: positive, max_output_tokens: positive,
    reserve_tokens: z.number().int().nonnegative().default(2000),
  }).strict(),
  compaction: z.object({
    enabled: z.boolean(), trigger_ratio: z.number().gt(0).lt(1),
    target_ratio: z.number().gt(0).lt(1), preserve_recent_turns: positive,
  }).strict(),
}).strict().superRefine((m, ctx) => {
  if (m.context.max_output_tokens + m.context.reserve_tokens >= m.context.window_tokens)
    ctx.addIssue({ code: 'custom', message: 'context output + reserve must be smaller than window' });
  if (m.compaction.target_ratio >= m.compaction.trigger_ratio)
    ctx.addIssue({ code: 'custom', message: 'compaction target must be below trigger' });
  if (m.reasoning.effort !== undefined && m.reasoning.budget_tokens !== undefined)
    ctx.addIssue({ code: 'custom', message: 'choose reasoning effort OR budget_tokens' });
});

const mcpBase = {
  serial: z.boolean().default(false),
  exclusive_group: z.string().min(1).max(80).optional(),
  per_session: z.boolean().default(false),
  timeout_ms: positive.max(3_600_000).default(60_000),
};
const mcpSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'), command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Non-secret environment values. */
    env: z.record(z.string(), z.string()).default({}),
    /** child env name -> parent environment variable name. */
    env_from: z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
    cwd: z.string().optional(),
    ...mcpBase,
  }).strict(),
  z.object({
    transport: z.literal('http'), url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
    api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    ...mcpBase,
  }).strict(),
]);

export const configSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), providerSchema),
  models: z.record(z.string(), modelSchema),
  defaults: z.object({
    model: z.string().min(1),
    max_concurrent_runs: positive.max(16),
    run_timeout_ms: positive,
    workspace: z.string().min(1),
    /** Undefined keeps state in memory. Relative paths resolve from the config file. */
    state_dir: z.string().min(1).optional(),
    max_input_queue: positive.max(100).default(8),
    max_steps: positive.max(200).default(24),
    exec_timeout_ms: positive.max(3_600_000).default(120_000),
    max_tool_output_bytes: positive.max(16_000_000).default(200_000),
  }).strict(),
  tools: z.object({
    builtin: z.array(z.enum(['read', 'write', 'edit', 'exec'])).default([]),
    bundled: z.object({ browser: z.boolean().optional(), desktop: z.boolean().optional() }).strict().optional(),
    mcp_servers: z.record(z.string(), mcpSchema).default({}),
    skill_roots: z.array(z.string()).default([]),
  }).strict(),
}).strict().superRefine((c, ctx) => {
  if (Object.keys(c.providers).length === 0)
    ctx.addIssue({ code: 'custom', message: 'at least one provider is required' });
  for (const [alias, model] of Object.entries(c.models)) {
    const provider = c.providers[model.provider];
    if (!provider) {
      ctx.addIssue({ code: 'custom', message: `model ${alias}: unknown provider ${model.provider}` });
      continue;
    }
    // Reject parameters that the declared wire protocol cannot carry instead of
    // silently dropping them. "demo" intentionally accepts both for simulation.
    if (provider.protocol === 'anthropic' && model.reasoning.effort !== undefined)
      ctx.addIssue({ code: 'custom', message: `model ${alias}: anthropic does not support effort; use budget_tokens` });
    if (provider.protocol !== 'anthropic' && provider.protocol !== 'demo' && model.reasoning.budget_tokens !== undefined)
      ctx.addIssue({ code: 'custom', message: `model ${alias}: ${provider.protocol} does not support budget_tokens; use effort` });
    if (provider.protocol === 'anthropic' && model.reasoning.budget_tokens !== undefined) {
      const budget = model.reasoning.budget_tokens;
      if (budget < 1024 || budget >= model.context.max_output_tokens)
        ctx.addIssue({ code: 'custom', message: `model ${alias}: thinking budget must be >=1024 and below max_output_tokens` });
    }
  }
  if (!c.models[c.defaults.model]) ctx.addIssue({ code: 'custom', message: 'default model does not exist' });
  for (const name of Object.keys(c.tools.mcp_servers)) {
    if (name.startsWith('agent_') || name.includes('__'))
      ctx.addIssue({ code: 'custom', message: `mcp server name ${name} is reserved or contains __` });
  }
});

export type Config = z.infer<typeof configSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type McpServerConfig = z.infer<typeof mcpSchema>;
export function parseConfig(value: unknown): Config { return configSchema.parse(value); }
export function loadConfig(path: string): Config {
  const absolute = resolve(path);
  const config = parseConfig(parse(readFileSync(absolute, 'utf8')));
  config.defaults.workspace = resolve(dirname(absolute), config.defaults.workspace);
  if (config.defaults.state_dir) config.defaults.state_dir = resolve(dirname(absolute), config.defaults.state_dir);
  config.tools.skill_roots = config.tools.skill_roots.map(p => resolve(dirname(absolute), p));
  config.tools.mcp_servers = resolveBundledBackends(config.tools.bundled, config.tools.mcp_servers, { workspace: config.defaults.workspace });
  delete config.tools.bundled;
  for (const server of Object.values(config.tools.mcp_servers)) {
    if (server.transport === 'stdio' && server.cwd) server.cwd = resolve(dirname(absolute), server.cwd);
  }
  return config;
}
