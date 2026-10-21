import type { ModelConfig, ProviderConfig } from '../config.js';
import type { Message, SessionSettings, ToolCall, Usage } from '../core/types.js';
import { usageFrom } from './context.js';

export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: ModelConfig;
  provider: ProviderConfig;
  settings: SessionSettings;
  system: string;
  messages: readonly Message[];
  tools: readonly ModelTool[];
  signal: AbortSignal;
}

export interface ModelResponse {
  text: string;
  tool_calls: ToolCall[];
  usage: Usage;
  finish_reason?: string;
}

export interface ModelClient {
  request(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'ModelError'; }
}

/** All three wire protocols share one client; dispatch happens per request. */
export class HttpModelClient implements ModelClient {
  async request(request: ModelRequest): Promise<ModelResponse> {
    const { provider } = request;
    if (provider.protocol === 'demo') throw new ModelError('DEMO_PROVIDER', 'demo providers are handled by the demo runner');
    const key = this.apiKey(provider);
    if (request.tools.length && !request.model.capabilities.tools)
      throw new ModelError('MODEL_TOOLS_UNSUPPORTED', 'model capability tools=false but tools are configured');
    if (request.messages.some(message => message.images?.length) && !request.model.capabilities.vision)
      throw new ModelError('MODEL_VISION_UNSUPPORTED', 'model capability vision=false but image content is present');
    switch (provider.protocol) {
      case 'openai_chat_completions': return this.openaiChat(request, key);
      case 'openai_responses': return this.openaiResponses(request, key);
      case 'anthropic': return this.anthropic(request, key);
    }
  }

  private apiKey(provider: ProviderConfig): string {
    const name = provider.api_key_env;
    if (!name) throw new ModelError('MISSING_API_KEY_ENV', 'provider has no api_key_env');
    const value = process.env[name];
    if (!value) throw new ModelError('MISSING_API_KEY_ENV', `${name} is not set in the plugin environment`);
    return value;
  }

  private async openaiChat(request: ModelRequest, key: string): Promise<ModelResponse> {
    const messages: unknown[] = [{ role: 'system', content: request.system }];
    for (const message of request.messages) {
      if (message.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: message.content || null,
          ...(message.tool_calls?.length ? {
            tool_calls: message.tool_calls.map(call => ({
              id: call.id, type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            })),
          } : {}),
        });
      } else if (message.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
      } else {
        messages.push({ role: 'user', content: chatUserContent(message) });
      }
    }
    const body: Record<string, unknown> = {
      model: request.model.model_id,
      messages,
      max_tokens: request.settings.max_output_tokens ?? request.model.context.max_output_tokens,
      stream: false,
    };
    if (request.settings.reasoning_effort !== undefined) body.reasoning_effort = request.settings.reasoning_effort;
    if (request.tools.length) {
      body.tools = request.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      }));
      body.tool_choice = 'auto';
    }
    const data = await this.post(endpoint(request.provider.base_url!, 'chat/completions'), key, request, body);
    const choice = asRecord(asArray(data.choices)[0]);
    const message = asRecord(choice.message);
    const text = chatText(message.content);
    const calls = asArray(message.tool_calls).map(parseOpenAiToolCall);
    if (!text && !calls.length)
      throw new ModelError('MODEL_RESPONSE_INVALID', `no text or tool calls (finish_reason=${String(choice.finish_reason)})`);
    return {
      text, tool_calls: calls,
      usage: openAiUsage(data.usage, 'openai_chat_completions'),
      finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    };
  }

  private async openaiResponses(request: ModelRequest, key: string): Promise<ModelResponse> {
    const input: unknown[] = [];
    for (const message of request.messages) {
      if (message.role === 'assistant') {
        if (message.content.trim()) input.push({ role: 'assistant', content: message.content });
        for (const call of message.tool_calls ?? [])
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) });
      } else if (message.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      } else if (message.images?.length) {
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: message.content },
            ...message.images.map(image => ({
              type: 'input_image', image_url: `data:${image.media_type};base64,${image.data}`,
            })),
          ],
        });
      } else {
        input.push({ role: 'user', content: message.content });
      }
    }
    const body: Record<string, unknown> = {
      model: request.model.model_id,
      instructions: request.system,
      input,
      max_output_tokens: request.settings.max_output_tokens ?? request.model.context.max_output_tokens,
    };
    if (request.settings.reasoning_effort !== undefined)
      body.reasoning = { effort: request.settings.reasoning_effort };
    if (request.tools.length) {
      body.tools = request.tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description,
        parameters: tool.input_schema, strict: false,
      }));
      body.tool_choice = 'auto';
    }
    const data = await this.post(endpoint(request.provider.base_url!, 'responses'), key, request, body);
    if (data.error) throw new ModelError('MODEL_RESPONSE_INVALID', safeText(JSON.stringify(data.error), key));
    let text = '';
    const calls: ToolCall[] = [];
    for (const item of asArray(data.output)) {
      const value = asRecord(item);
      if (value.type === 'function_call') {
        const id = typeof value.call_id === 'string' ? value.call_id : value.id;
        if (typeof id !== 'string' || typeof value.name !== 'string')
          throw new ModelError('MODEL_RESPONSE_INVALID', 'function_call without call_id/name');
        calls.push({ id, name: value.name, arguments: parseArguments(value.arguments) });
      } else if (value.type === 'message') {
        for (const part of asArray(value.content)) {
          const block = asRecord(part);
          if (block.type === 'output_text' && typeof block.text === 'string') text += block.text;
        }
      }
    }
    if (!text && typeof data.output_text === 'string') text = data.output_text;
    if (!text && !calls.length)
      throw new ModelError('MODEL_RESPONSE_INVALID', `no text or tool calls (${String(data.status ?? 'unknown')})`);
    return {
      text, tool_calls: calls, usage: openAiUsage(data.usage, 'openai_responses'),
      finish_reason: typeof data.status === 'string' ? data.status : undefined,
    };
  }

  private async anthropic(request: ModelRequest, key: string): Promise<ModelResponse> {
    const messages = anthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model.model_id,
      system: request.system,
      messages,
      max_tokens: request.settings.max_output_tokens ?? request.model.context.max_output_tokens,
    };
    if (request.settings.reasoning_budget_tokens !== undefined) {
      const budget = request.settings.reasoning_budget_tokens;
      const maxTokens = Number(body.max_tokens);
      if (budget < 1024 || budget >= maxTokens)
        throw new ModelError('INVALID_THINKING_BUDGET', `budget_tokens must be >=1024 and below max_tokens (${budget} / ${maxTokens})`);
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
    if (request.tools.length)
      body.tools = request.tools.map(tool => ({
        name: tool.name, description: tool.description, input_schema: tool.input_schema,
      }));
    const base = request.provider.base_url!.replace(/\/+$/, '');
    const url = base.endsWith('/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const data = await this.post(url, key, request, body, { 'anthropic-version': '2023-06-01' });
    let text = '';
    const calls: ToolCall[] = [];
    for (const block of asArray(data.content)) {
      const value = asRecord(block);
      if (value.type === 'text' && typeof value.text === 'string') text += value.text;
      else if (value.type === 'tool_use' && typeof value.id === 'string' && typeof value.name === 'string')
        calls.push({ id: value.id, name: value.name, arguments: value.input ?? {} });
    }
    if (!text && !calls.length)
      throw new ModelError('MODEL_RESPONSE_INVALID', `no text or tool calls (${String(data.stop_reason ?? 'unknown')})`);
    return {
      text, tool_calls: calls, usage: anthropicUsage(data.usage),
      finish_reason: typeof data.stop_reason === 'string' ? data.stop_reason : undefined,
    };
  }

  private async post(
    url: string, key: string, request: ModelRequest, body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json', ...request.provider.headers,
      ...authHeaders(request.provider, key), ...extraHeaders,
    };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const cause = error instanceof Error ? error.message : String(error);
      throw new ModelError('MODEL_NETWORK_ERROR', safeText(cause, key));
    }
    const raw = await response.text();
    if (!response.ok)
      throw new ModelError(`MODEL_HTTP_${response.status}`, safeText(raw.slice(0, 4000), key));
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new ModelError('MODEL_RESPONSE_INVALID', 'response was not JSON');
    }
  }
}

/**
 * Provider gateways disagree on credential headers. Anthropic defaults to
 * x-api-key with a raw value; OpenAI-style endpoints default to Bearer.
 * An explicit header override without a prefix means the raw key is sent.
 */
function authHeaders(provider: ProviderConfig, key: string): Record<string, string> {
  const protocolDefaultHeader = provider.protocol === 'anthropic' ? 'x-api-key' : 'authorization';
  const protocolDefaultPrefix = provider.protocol === 'anthropic' ? '' : 'Bearer';
  const header = provider.api_key_header ?? protocolDefaultHeader;
  const prefix = provider.api_key_prefix !== undefined
    ? provider.api_key_prefix
    : provider.api_key_header ? '' : protocolDefaultPrefix;
  return { [header]: prefix ? `${prefix} ${key}` : key };
}

function endpoint(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith(`/${path}`)) return trimmed;
  return `${trimmed}/${path}`;
}

function chatUserContent(message: Message): unknown {
  if (!message.images?.length) return message.content;
  return [
    { type: 'text', text: message.content },
    ...message.images.map(image => ({
      type: 'image_url', image_url: { url: `data:${image.media_type};base64,${image.data}` },
    })),
  ];
}

function chatText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map(part => {
      const value = asRecord(part);
      return typeof value.text === 'string' ? value.text : '';
    }).join('');
  return '';
}

function parseOpenAiToolCall(value: unknown): ToolCall {
  const call = asRecord(value);
  const fn = asRecord(call.function);
  if (typeof call.id !== 'string' || typeof fn.name !== 'string')
    throw new ModelError('MODEL_RESPONSE_INVALID', 'tool call without id/name');
  return { id: call.id, name: fn.name, arguments: parseArguments(fn.arguments) };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  if (!value.trim()) return {};
  try { return JSON.parse(value); }
  catch { throw new ModelError('MODEL_RESPONSE_INVALID', 'tool arguments are not valid JSON'); }
}

function anthropicMessages(messages: readonly Message[]): unknown[] {
  const output: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  const push = (role: 'user' | 'assistant', content: unknown[]) => {
    const last = output.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else output.push({ role, content: [...content] });
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      push('user', [{
        type: 'tool_result', tool_use_id: message.tool_call_id,
        content: message.content || '(empty)', ...(message.is_error ? { is_error: true } : {}),
      }]);
    } else if (message.role === 'assistant') {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? [])
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
      if (content.length) push('assistant', content);
    } else {
      const content: unknown[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const image of message.images ?? [])
        content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
      if (content.length) push('user', content);
    }
  }
  return output;
}

function openAiUsage(value: unknown, source: string): Usage {
  const usage = asRecord(value);
  return usageFrom(
    typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens : typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    source,
  );
}

function anthropicUsage(value: unknown): Usage {
  const usage = asRecord(value);
  return usageFrom(
    typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    'anthropic',
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function safeText(value: string, key: string): string {
  const redacted = key ? value.split(key).join('[redacted]') : value;
  return redacted.slice(0, 4000);
}

export function providerModes(model: ModelConfig): { effort: boolean; budget: boolean } {
  return { effort: model.reasoning.effort !== undefined, budget: model.reasoning.budget_tokens !== undefined };
}
