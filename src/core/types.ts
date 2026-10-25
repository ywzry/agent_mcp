import type { ModelConfig, ReasoningEffort } from '../config.js';

export type RunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

/** One model-visible tool invocation. Arguments are kept as parsed JSON. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface MessageImage {
  media_type: string;
  /** Base64 payload without a data: prefix. */
  data: string;
}

/** Opaque provider continuation data, persisted but not exposed by inspect. */
export type ProviderState =
  | { protocol: 'openai_chat_completions'; reasoning_content: string }
  | { protocol: 'openai_responses'; output: Record<string, unknown>[] }
  | { protocol: 'anthropic'; content: Record<string, unknown>[] };

/**
 * Provider-neutral conversation record. Tool calls and tool results are stored
 * as separate messages so they can always be persisted and replayed as a pair.
 */
export interface Message {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  run_id: string;
  at: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  is_error?: boolean;
  images?: MessageImage[];
  provider_state?: ProviderState;
}

export interface MessageInput {
  role: Message['role'];
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  is_error?: boolean;
  images?: MessageImage[];
  provider_state?: ProviderState;
}

export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  /** True when the values are local estimates rather than provider counters. */
  estimated: boolean;
  source: string;
}

export interface ArtifactRef {
  id: string;
  name: string;
  kind: 'text' | 'image' | 'file';
  mime: string;
  bytes: number;
  run_id: string;
  created_at: string;
}

export interface CommandEvidence {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  output_artifact?: string;
  /** The process reaper hit its fallback before confirming child exit. */
  cleanup_unconfirmed?: boolean;
}

export interface RunResult {
  summary: string;
  /** Only the demo runner sets this. Real model work must never claim simulated success. */
  simulated: boolean;
  usage?: Usage;
  steps?: number;
  tool_calls?: number;
  artifacts?: ArtifactRef[];
  /** Unified diff for files changed by built-in write/edit tools during this run. */
  diff?: string;
  commands?: CommandEvidence[];
  model_id?: string;
}

export interface Run {
  id: string;
  session_id: string;
  task: string;
  status: RunStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  result?: RunResult;
  error?: string;
  usage?: Usage;
  cancel_reason?: 'user' | 'timeout' | 'shutdown' | 'restart';
}

export interface SessionSettings {
  reasoning_effort?: ReasoningEffort;
  reasoning_budget_tokens?: number;
  max_output_tokens?: number;
}

export interface Session {
  id: string;
  name: string;
  tags: string[];
  model: string;
  model_config: ModelConfig;
  settings: SessionSettings;
  workspace: string;
  created_at: string;
  run_ids: string[];
  history: Message[];
}

export interface SessionEvent {
  seq: number;
  run_id: string;
  at: string;
  type: string;
  message: string;
  data?: unknown;
}

export interface QueuedInput {
  id: string;
  run_id: string;
  content: string;
  status: 'queued' | 'delivered' | 'dropped';
  received_at: string;
  delivered_at?: string;
}

export interface ConsumedInput {
  input: QueuedInput;
  /** The persisted user message appended for this input. */
  message: Message;
}

export interface CompactionState {
  summary: string;
  /** Last original history sequence folded into the summary. */
  through_seq: number;
  count: number;
  updated_at: string;
  estimated_tokens?: number;
}

export interface ArtifactInput {
  name: string;
  kind: ArtifactRef['kind'];
  mime?: string;
  data: string | Buffer;
}

/** Execution facts reported to the host. Configuration declarations are not capabilities. */
export interface RuntimeDescription {
  persistence: boolean;
  real_models: boolean;
  protocols: string[];
  coding_tools: boolean;
  downstream_mcp: boolean;
  skills: boolean;
  compaction: boolean;
  input_queue: boolean;
  credentials: Record<string, boolean>;
  backends: Array<{ name: string; transport: string; connected: boolean; per_session: boolean; error?: string }>;
}

export interface RunContext {
  session: Readonly<Session>;
  run: Readonly<Run>;
  /** Working context at run start: compacted summary tail (not the raw archive). */
  history: readonly Message[];
  summary?: string;
  workspace: string;
  signal: AbortSignal;
  emit: (type: string, message: string, data?: unknown) => void;
  /** Append to the raw archive. Returns an independent working copy. */
  append: (message: MessageInput) => Message;
  /** Consume pending user inputs. Safe boundary: after complete tool results. */
  takeInputs: () => ConsumedInput[];
  /** Persist a summarization checkpoint without deleting the original messages. */
  setCompaction: (summary: string, throughSeq: number, estimatedTokens?: number) => void;
  /** Save large output or image bytes and return a host-readable reference. */
  saveArtifact: (input: ArtifactInput) => ArtifactRef;
}

/** The only execution extension point. */
export interface Runner {
  run: (context: RunContext) => Promise<RunResult>;
  describe: () => RuntimeDescription;
  close?: () => Promise<void>;
}

export interface StartInput {
  task: string;
  model?: string;
  name?: string;
  tags?: string[];
  reasoning_effort?: ReasoningEffort;
  reasoning_budget_tokens?: number;
  max_output_tokens?: number;
}

export interface SendInput {
  session_id: string;
  task?: string;
  name?: string;
  tags?: string[];
}

export function isTerminal(run: Run): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}
