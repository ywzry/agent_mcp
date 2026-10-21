import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { reasoningEfforts } from '../config.js';
import type { SessionManager } from '../core/sessions.js';

const id = z.string().min(1).describe('ID returned by agent_start or agent_send');
const tags = z.array(z.string().min(1).max(80)).max(20).describe('Organization labels only; never grant tools or select a model');
const name = z.string().min(1).max(120).describe('Human-readable session name');
const task = z.string().trim().min(1).max(32000).describe('Task goal, constraints and acceptance criteria');
const settings = {
  reasoning_effort: z.enum(reasoningEfforts).optional().describe('Session override; rejected unless the model config accepts effort'),
  reasoning_budget_tokens: z.number().int().min(1024).optional().describe('Session override; rejected unless the model config accepts a thinking budget'),
  max_output_tokens: z.number().int().positive().optional().describe('Session override; cannot exceed the model output limit'),
};
const response = (action: () => object) => {
  try {
    const value = action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'INTERNAL_ERROR' }] };
  }
};

export function createServer(manager: SessionManager) {
  const server = new McpServer({ name: 'agent-mcp', version: '0.2.0' }, {
    instructions: 'Generic multi-model execution plugin. Call agent_inspect with no arguments for models, credentials, backends and actual capabilities. All sessions are the same object; names and tags are metadata only. Start returns IDs immediately; inspect polls persisted lifecycle events. agent_send during a run queues a bounded message delivered at the next complete tool-result boundary. For real protocols, API keys are read from configured environment variable names and never returned.',
  });
  server.registerTool('agent_start', {
    description: 'Create a generic session with a chosen model and start a run. Returns session_id/run_id immediately. Real execution depends on configured provider credentials and tools; capability declarations are not proof.',
    inputSchema: z.object({ task, model: z.string().min(1).optional().describe('Configured model alias; defaults to config'), name: name.optional(), tags: tags.optional(), ...settings }).strict(),
  }, input => response(() => manager.start(input)));
  server.registerTool('agent_inspect', {
    description: 'Without session_id list sessions/models/credentials/backends. With session_id return run state, result, artifacts, context counts and up to 100 events after cursor. Read artifact content with artifact_id. include_history returns the raw persisted record (capped).',
    inputSchema: z.object({
      session_id: id.optional(),
      run_id: id.optional(),
      after_cursor: z.number().int().nonnegative().default(0).describe('Session event cursor; initially 0'),
      include_history: z.boolean().default(false).describe('Include up to the last 500 raw history messages'),
      artifact_id: z.string().min(1).optional().describe('Read artifact content; requires session_id'),
      artifact_max_bytes: z.number().int().positive().max(8_000_000).default(2_000_000),
      session_offset: z.number().int().nonnegative().default(0).describe('Session list offset when no session_id is given'),
      session_limit: z.number().int().positive().max(200).default(100),
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, input => response(() => {
    if (input.artifact_id) {
      if (!input.session_id) throw new Error('session_id is required with artifact_id');
      return manager.readArtifact(input.session_id, input.artifact_id, input.artifact_max_bytes);
    }
    if (!input.session_id && input.run_id) throw new Error('session_id is required with run_id');
    return input.session_id
      ? manager.inspect(input.session_id, input.after_cursor, input.run_id, input.include_history)
      : manager.list(input.session_offset, input.session_limit);
  }));
  server.registerTool('agent_send', {
    description: 'Rename/tag a session or submit work. If the current run is active, the task is queued (bounded) and delivered at the next complete tool-result boundary; a message_id and delivery=queued is returned. If idle, it starts a new run in the same context.',
    inputSchema: z.object({ session_id: id, task: task.optional(), name: name.optional(), tags: tags.optional() }).strict(),
  }, input => response(() => manager.send(input)));
  server.registerTool('agent_cancel', {
    description: 'Cancel the specified current run. The run stays cancelling until the executor, shell process tree and downstream calls actually stop; inspect for confirmation. Later cancel requests for a terminal run do not change its result.',
    inputSchema: z.object({ session_id: id, run_id: id }).strict(),
    annotations: { idempotentHint: true },
  }, input => response(() => manager.cancel(input.session_id, input.run_id)));
  return server;
}
