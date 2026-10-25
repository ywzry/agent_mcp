import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type {
  ArtifactInput, ArtifactRef, CompactionState, ConsumedInput, Message, MessageInput, QueuedInput, Run,
  Runner, RunResult, RuntimeDescription, SendInput, Session, SessionEvent, SessionSettings, StartInput,
} from './types.js';
import { isTerminal } from './types.js';
import { contextBudget, estimateMessages } from '../runtime/context.js';
import { Store, type SessionFile } from './store.js';

interface State {
  session: Session;
  runs: Map<string, Run>;
  events: SessionEvent[];
  inbox: QueuedInput[];
  context: CompactionState | null;
  artifacts: Map<string, ArtifactRef>;
}

const timestamp = () => new Date().toISOString();
const MAX_LIST_SESSIONS = 200;

export interface Inspection {
  session: Omit<Session, 'history'>;
  run: Run;
  events: SessionEvent[];
  next_cursor: number;
  has_more: boolean;
  history_messages: number;
  inbox: QueuedInput[];
  context: {
    input_tokens: number; trigger_tokens: number; target_tokens: number;
    used_tokens: number | null; estimated: boolean; estimate_source: string;
    compaction_status: string; compaction_count: number; summary_preview?: string; archived_through_seq: number;
  };
  artifacts: ArtifactRef[];
  persistence: string;
  history?: Array<Message & { content_truncated?: boolean; images_omitted?: number; provider_state_omitted?: boolean }>;
  history_truncated?: boolean;
}

/**
 * Single-process session manager. Persistence, when configured, is a local
 * append-safe snapshot store; runs are never replayed after a restart.
 */
export class SessionManager {
  private states = new Map<string, State>();
  private runs = new Map<string, Run>();
  private queue: string[] = [];
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private store: Store;

  constructor(private config: Config, private runner: Runner) {
    this.store = new Store(config.defaults.state_dir, `agent-mcp pid ${process.pid}`);
    for (const warning of this.store.warnings) console.error(warning);
    for (const file of this.store.loadSessions()) this.restore(file);
  }

  start(input: StartInput) {
    this.assertOpen();
    if (!input.task.trim()) throw new Error('EMPTY_TASK');
    const model = input.model ?? this.config.defaults.model;
    const settings = this.config.models[model];
    if (!settings) throw new Error(`UNKNOWN_MODEL: ${model}`);
    const resolved = this.resolveSettings(settings, input);
    const session: Session = {
      id: randomUUID(), name: input.name ?? input.task.slice(0, 60), tags: [...(input.tags ?? [])],
      model, model_config: structuredClone(settings), settings: resolved,
      workspace: this.config.defaults.workspace, created_at: timestamp(), run_ids: [], history: [],
    };
    const state: State = {
      session, runs: new Map(), events: [], inbox: [], context: null, artifacts: new Map(),
    };
    this.states.set(session.id, state);
    const ids = this.enqueue(state, input.task);
    this.save(state);
    return ids;
  }

  send(input: SendInput) {
    this.assertOpen();
    const state = this.getState(input.session_id);
    const current = this.latest(state);
    if (input.task !== undefined && !input.task.trim()) throw new Error('EMPTY_TASK');
    const applyMetadata = () => {
      if (input.name !== undefined) state.session.name = input.name;
      if (input.tags !== undefined) state.session.tags = [...input.tags];
    };
    if (input.task === undefined) {
      applyMetadata();
      this.event(state, current, 'session.updated', 'Session name/tags updated; model and capabilities unchanged.');
      this.save(state);
      return { session_id: state.session.id, run_id: current.id };
    }
    if (!isTerminal(current)) {
      if (current.status === 'cancelling') throw new Error('RUN_CANCELLING: wait for the current run to stop');
      const pending = state.inbox.filter(item => item.run_id === current.id && item.status === 'queued');
      if (pending.length >= this.config.defaults.max_input_queue)
        throw new Error(`INBOX_FULL: at most ${this.config.defaults.max_input_queue} pending messages`);
      applyMetadata();
      const queued: QueuedInput = {
        id: randomUUID(), run_id: current.id, content: input.task, status: 'queued', received_at: timestamp(),
      };
      state.inbox.push(queued);
      this.event(state, current, 'input.queued', `Message queued at a tool-result boundary (${pending.length + 1}/${this.config.defaults.max_input_queue}).`, { message_id: queued.id });
      this.save(state);
      return {
        session_id: state.session.id, run_id: current.id, message_id: queued.id,
        accepted: true, delivery: 'queued',
      };
    }
    applyMetadata();
    if (input.name !== undefined || input.tags !== undefined) {
      this.event(state, current, 'session.updated', 'Session name/tags updated before the next run.');
    }
    const ids = this.enqueue(state, input.task);
    this.save(state);
    return ids;
  }

  inspect(sessionId: string, after = 0, runId?: string, includeHistory = false): Inspection {
    const state = this.getState(sessionId);
    const run = runId ? state.runs.get(runId) : this.latest(state);
    if (!run || run.session_id !== state.session.id) throw new Error('RUN_NOT_FOUND');
    const allEvents = state.events;
    const events = allEvents.filter(e => e.seq > after).slice(0, 100);
    const lastSeq = events.at(-1)?.seq ?? after;
    const { history, ...metadata } = state.session;
    const cutoff = state.context?.through_seq ?? 0;
    const working = history.filter(m => m.seq > cutoff);
    const estimate = estimateMessages(working, state.context?.summary);
    const result: Inspection = {
      session: metadata,
      run,
      events,
      next_cursor: lastSeq,
      has_more: allEvents.some(e => e.seq > lastSeq),
      history_messages: history.length,
      inbox: state.inbox.filter(item => item.run_id === run.id).map(item => ({ ...item })),
      context: {
        ...contextBudget(state.session.model_config),
        used_tokens: run.usage?.input_tokens ?? estimate.total,
        estimated: run.usage ? run.usage.estimated : true,
        estimate_source: run.usage?.source ?? 'local_estimate',
        compaction_status: state.session.model_config.compaction.enabled
          ? (state.context ? 'active' : 'ready') : 'disabled',
        compaction_count: state.context?.count ?? 0,
        summary_preview: state.context?.summary.slice(0, 500),
        archived_through_seq: cutoff,
      },
      artifacts: [...state.artifacts.values()].slice(-100).map(ref => ({ ...ref })),
      persistence: this.store.persistent ? 'local_state_dir' : 'memory_only',
    };
    if (includeHistory) {
      const capped = history.slice(-500);
      let truncated = history.length > capped.length;
      result.history = capped.map(message => {
        const copy: Message & { content_truncated?: boolean; images_omitted?: number; provider_state_omitted?: boolean } = { ...message };
        if (copy.provider_state) {
          delete copy.provider_state;
          copy.provider_state_omitted = true;
          truncated = true;
        }
        if (copy.content.length > 8000) {
          copy.content = `${copy.content.slice(0, 8000)}\n[history content truncated; ${copy.content.length} characters total]`;
          copy.content_truncated = true;
          truncated = true;
        }
        if (copy.images?.length) {
          copy.images_omitted = copy.images.length;
          delete copy.images;
          truncated = true;
        }
        return copy;
      });
      result.history_truncated = truncated;
    }
    return structuredClone(result);
  }

  list(offset = 0, limit = 100) {
    const description = this.runner.describe();
    const all = [...this.states.values()];
    const safeLimit = Math.min(Math.max(1, limit), MAX_LIST_SESSIONS);
    const start = Math.min(Math.max(0, offset), all.length);
    const page = all.slice(start, start + safeLimit);
    const sessions = page.map(state => {
      const run = this.latest(state);
      return {
        session_id: state.session.id, name: state.session.name, tags: [...state.session.tags],
        model: state.session.model, run_id: run.id, status: run.status,
        created_at: state.session.created_at, history_messages: state.session.history.length,
        pending_inputs: state.inbox.filter(item => item.status === 'queued').length,
      };
    });
    return {
      implementation: 'real_loop',
      persistence: this.store.persistent ? 'local_state_dir' : 'memory_only',
      state_dir: this.config.defaults.state_dir,
      capabilities: {
        real_models: description.real_models,
        coding_tools: description.coding_tools,
        downstream_mcp: description.downstream_mcp,
        skills: description.skills,
        compaction: description.compaction,
        input_queue: description.input_queue,
        protocols: description.protocols,
        backends: description.backends,
      },
      models: Object.entries(this.config.models).map(([alias, model]) => {
        const provider = this.config.providers[model.provider]!;
        return {
          alias, model_id: model.model_id, provider: model.provider, protocol: provider.protocol,
          description: model.description, configured_capabilities: model.capabilities,
          reasoning: model.reasoning,
          credential_present: provider.protocol === 'demo'
            ? true : Boolean(provider.api_key_env && description.credentials[provider.api_key_env]),
        };
      }),
      sessions,
      sessions_total: all.length,
      sessions_offset: start,
      sessions_truncated: start + sessions.length < all.length,
    };
  }

  cancel(sessionId: string, runId: string) {
    const state = this.getState(sessionId);
    const run = this.latest(state);
    if (run.id !== runId) throw new Error('RUN_MISMATCH: cancellation must target the current run');
    if (isTerminal(run)) return this.inspect(sessionId);
    const active = this.active.get(run.id);
    if (active) {
      run.status = 'cancelling';
      run.cancel_reason ??= 'user';
      active.controller.abort();
      this.event(state, run, 'run.cancelling', 'Cancellation requested; waiting for executor and tool processes to stop.');
    } else {
      this.queue = this.queue.filter(id => id !== run.id);
      run.status = 'cancelled'; run.finished_at = timestamp(); run.cancel_reason = 'user'; run.error = 'CANCELLED';
      this.event(state, run, 'run.cancelled', 'Cancelled before execution.');
    }
    this.save(state);
    return this.inspect(sessionId);
  }

  readArtifact(sessionId: string, artifactId: string, maxBytes = 2_000_000) {
    const state = this.getState(sessionId);
    const ref = state.artifacts.get(artifactId);
    if (!ref) throw new Error('ARTIFACT_NOT_FOUND');
    const bytes = this.store.readArtifact(ref);
    const slice = bytes.subarray(0, Math.max(1, maxBytes));
    const truncated = slice.length < bytes.length;
    return {
      artifact: { ...ref },
      encoding: ref.kind === 'text' ? 'utf8' : 'base64',
      data: ref.kind === 'text' ? slice.toString('utf8') : slice.toString('base64'),
      returned_bytes: slice.length,
      truncated,
    };
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const state of this.states.values()) {
        const run = this.latest(state);
        if (isTerminal(run)) continue;
        const active = this.active.get(run.id);
        if (active) {
          run.status = 'cancelling'; run.cancel_reason = 'shutdown';
          active.controller.abort();
          this.event(state, run, 'run.cancelling', 'Plugin is shutting down; waiting for tools to stop.');
        } else {
          this.queue = this.queue.filter(id => id !== run.id);
          run.status = 'cancelled'; run.error = 'CANCELLED'; run.cancel_reason = 'shutdown'; run.finished_at = timestamp();
          this.event(state, run, 'run.cancelled', 'Cancelled before execution because the plugin is shutting down.');
        }
        this.save(state);
      }
      await Promise.all([...this.active.values()].map(item => item.done));
      try { await this.runner.close?.(); } finally { this.store.close(); }
    })();
    return this.closing;
  }

  private restore(file: SessionFile): void {
    const state: State = {
      session: file.session,
      runs: new Map(file.runs.map(run => [run.id, run])),
      events: [...file.events],
      inbox: [...file.inbox],
      context: file.context ?? null,
      artifacts: new Map(file.artifacts.map(ref => [ref.id, ref])),
    };
    if (!state.session.settings) state.session.settings = this.resolveSettings(state.session.model_config, { task: '' });
    this.states.set(state.session.id, state);
    for (const run of state.runs.values()) this.runs.set(run.id, run);
    let changed = false;
    for (const run of state.runs.values()) {
      if (!isTerminal(run)) {
        run.status = 'failed';
        run.error = 'INTERRUPTED: plugin restarted before this run completed; side effects were not replayed.';
        run.finished_at = timestamp();
        run.cancel_reason = 'restart';
        this.event(state, run, 'run.interrupted', run.error);
        changed = true;
      }
    }
    for (const item of state.inbox) {
      if (item.status === 'queued') {
        item.status = 'dropped';
        const run = state.runs.get(item.run_id);
        if (run) this.event(state, run, 'input.dropped', 'Queued input was not executed because the plugin restarted.', { message_id: item.id });
        changed = true;
      }
    }
    if (changed) this.save(state);
  }

  private resolveSettings(model: Session['model_config'], input: StartInput): SessionSettings {
    if (input.reasoning_effort !== undefined && input.reasoning_budget_tokens !== undefined)
      throw new Error('CHOOSE_REASONING_MODE: effort OR budget_tokens');
    if (input.reasoning_effort !== undefined) {
      if (model.reasoning.effort === undefined)
        throw new Error('UNSUPPORTED_REASONING_EFFORT: model does not accept effort');
    }
    if (input.reasoning_budget_tokens !== undefined) {
      if (model.reasoning.budget_tokens === undefined)
        throw new Error('UNSUPPORTED_REASONING_BUDGET: model does not accept budget_tokens');
    }
    const maxOutput = input.max_output_tokens ?? model.context.max_output_tokens;
    if (maxOutput > model.context.max_output_tokens)
      throw new Error(`MAX_OUTPUT_EXCEEDS_MODEL: ${maxOutput} > ${model.context.max_output_tokens}`);
    const settings: SessionSettings = { max_output_tokens: maxOutput };
    const effort = input.reasoning_effort ?? model.reasoning.effort;
    const budget = input.reasoning_budget_tokens ?? model.reasoning.budget_tokens;
    if (effort !== undefined) settings.reasoning_effort = effort;
    if (budget !== undefined) {
      if (budget < 1024 || budget >= maxOutput)
        throw new Error('INVALID_THINKING_BUDGET: budget_tokens must be >=1024 and below max_output_tokens');
      settings.reasoning_budget_tokens = budget;
    }
    return settings;
  }

  private enqueue(state: State, task: string) {
    const run: Run = {
      id: randomUUID(), session_id: state.session.id, task, status: 'queued', created_at: timestamp(),
    };
    state.session.run_ids.push(run.id);
    state.runs.set(run.id, run);
    this.runs.set(run.id, run);
    this.queue.push(run.id);
    this.event(state, run, 'run.queued', 'Waiting for an execution slot.');
    queueMicrotask(() => this.drain());
    return { session_id: state.session.id, run_id: run.id };
  }

  private drain() {
    while (!this.closed && this.active.size < this.config.defaults.max_concurrent_runs && this.queue.length) {
      const run = this.runs.get(this.queue.shift()!)!;
      if (run.status !== 'queued') continue;
      const controller = new AbortController();
      const done = Promise.resolve().then(() => this.execute(run, controller));
      this.active.set(run.id, { controller, done });
    }
  }

  private async execute(run: Run, controller: AbortController) {
    const state = this.getState(run.session_id);
    let timedOut = false;
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true; run.status = 'cancelling'; run.cancel_reason = 'timeout'; controller.abort();
      const detail = 'Time budget reached; waiting for executor and tools to stop.';
      this.event(state, run, 'run.timeout', detail);
      this.save(state);
    }, this.config.defaults.run_timeout_ms);
    try {
      controller.signal.throwIfAborted();
      run.status = 'running'; run.started_at = timestamp();
      this.event(state, run, 'run.started', `Executor started with ${run.task.length} character task.`);
      this.appendInternal(state, run, { role: 'user', content: run.task });
      const cutoff = state.context?.through_seq ?? 0;
      const history = structuredClone(state.session.history.filter(message => message.seq > cutoff));
      const result = await this.runner.run({
        session: structuredClone(state.session),
        run: structuredClone(run),
        history,
        summary: state.context?.summary,
        workspace: state.session.workspace,
        signal: controller.signal,
        emit: (type, message, data) => {
          if (isTerminal(run)) return;
          this.event(state, run, type, message, data);
          this.save(state);
        },
        append: message => {
          const stored = this.appendInternal(state, run, message);
          this.save(state);
          return stored;
        },
        takeInputs: () => this.takeInputs(state, run),
        setCompaction: (summary, throughSeq, estimatedTokens) => {
          state.context = {
            summary, through_seq: throughSeq, count: (state.context?.count ?? 0) + 1,
            updated_at: timestamp(), estimated_tokens: estimatedTokens,
          };
          this.event(state, run, 'context.compacted', `Earlier complete turns summarized; raw history retained (through seq ${throughSeq}).`);
          this.save(state);
        },
        saveArtifact: input => this.saveArtifactInternal(state, run, input),
      });
      controller.signal.throwIfAborted();
      run.result = result;
      run.usage = result.usage;
      for (const ref of result.artifacts ?? []) if (!state.artifacts.has(ref.id)) state.artifacts.set(ref.id, ref);
      run.status = 'completed';
      if (!this.hasAssistantMessage(state, run.id))
        this.appendInternal(state, run, { role: 'assistant', content: result.summary });
    } catch (error) {
      const unconfirmed = error instanceof Error && 'code' in error && error.code === 'STOP_UNCONFIRMED';
      run.status = unconfirmed || timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed';
      run.error = unconfirmed ? error.message : timedOut ? 'RUN_TIMEOUT'
        : controller.signal.aborted ? (run.cancel_reason === 'shutdown' ? 'PLUGIN_SHUTDOWN' : 'CANCELLED')
          : error instanceof Error ? error.message : 'EXECUTOR_FAILED';
      if (controller.signal.aborted) run.cancel_reason ??= timedOut ? 'timeout' : 'user';
    } finally {
      clearTimeout(timer); run.finished_at = timestamp();
      this.event(state, run, `run.${run.status}`, run.error ?? 'Executor finished.');
      this.active.delete(run.id);
      this.settlePendingInputs(state, run);
      this.save(state);
      this.drain();
    }
  }

  /**
   * A message that arrived too late for the runner's final tool boundary must
   * not be lost. On normal completion it becomes one follow-up run; after a
   * cancel/failure it is dropped explicitly instead of being replayed.
   */
  private settlePendingInputs(state: State, run: Run) {
    const pending = state.inbox.filter(item => item.run_id === run.id && item.status === 'queued');
    if (!pending.length) return;
    for (const item of pending) {
      item.status = run.status === 'completed' ? 'delivered' : 'dropped';
      item.delivered_at = timestamp();
    }
    if (run.status === 'completed' && !this.closed) {
      const task = pending.map(item => item.content).join('\n\n');
      const ids = this.enqueue(state, task);
      for (const item of pending)
        this.event(state, run, 'input.follow_up', `Message was queued too late for the final boundary; started follow-up run ${ids.run_id}.`, { message_id: item.id, run_id: ids.run_id });
    } else {
      for (const item of pending)
        this.event(state, run, 'input.dropped', `Queued message was not executed because the run ended as ${run.status}.`, { message_id: item.id });
    }
  }

  private takeInputs(state: State, run: Run) {
    const pending = state.inbox.filter(item => item.run_id === run.id && item.status === 'queued');
    if (!pending.length) return [];
    const consumed: ConsumedInput[] = [];
    for (const item of pending) {
      item.status = 'delivered';
      item.delivered_at = timestamp();
      const message = this.appendInternal(state, run, { role: 'user', content: item.content });
      this.event(state, run, 'input.delivered', `Queued message delivered at a tool-result boundary (${item.id}).`, { message_id: item.id });
      consumed.push({ input: { ...item }, message });
    }
    this.save(state);
    return consumed;
  }

  private appendInternal(state: State, run: Run, input: MessageInput): Message {
    const last = state.session.history.at(-1);
    const message: Message = {
      seq: (last?.seq ?? 0) + 1, role: input.role, content: input.content,
      run_id: run.id, at: timestamp(),
      ...(input.tool_calls ? { tool_calls: structuredClone(input.tool_calls) } : {}),
      ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.is_error ? { is_error: true } : {}),
      ...(input.images?.length ? { images: structuredClone(input.images) } : {}),
      ...(input.provider_state ? { provider_state: structuredClone(input.provider_state) } : {}),
    };
    state.session.history.push(message);
    return structuredClone(message);
  }

  private saveArtifactInternal(state: State, run: Run, input: ArtifactInput): ArtifactRef {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
    const ref: ArtifactRef = {
      id: randomUUID(), name: input.name, kind: input.kind,
      mime: input.mime ?? (input.kind === 'image' ? 'image/png' : input.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
      bytes: data.length, run_id: run.id, created_at: timestamp(),
    };
    this.store.saveArtifact(ref, data);
    state.artifacts.set(ref.id, ref);
    this.save(state);
    return ref;
  }

  private hasAssistantMessage(state: State, runId: string): boolean {
    const last = state.session.history.at(-1);
    return last?.run_id === runId && last.role === 'assistant';
  }

  private event(state: State, run: Run, type: string, message: string, data?: unknown) {
    state.events.push({
      seq: state.events.length + 1, run_id: run.id, at: timestamp(), type, message,
      ...(data === undefined ? {} : { data }),
    });
  }

  private save(state: State) {
    this.store.saveSession({
      version: 1, session: state.session, runs: [...state.runs.values()],
      events: state.events, inbox: state.inbox, context: state.context,
      artifacts: [...state.artifacts.values()],
    });
  }

  private latest(state: State) { return state.runs.get(state.session.run_ids.at(-1)!)!; }
  private getState(id: string) {
    const state = this.states.get(id);
    if (!state) throw new Error('SESSION_NOT_FOUND');
    return state;
  }
  private assertOpen() { if (this.closed) throw new Error('MANAGER_CLOSED'); }
}

export type { RunResult, RuntimeDescription };
