import type { Message, Usage } from '../core/types.js';
import type { ModelConfig } from '../config.js';

/** Budget arithmetic only; actual counting happens in estimateMessages/model usage. */
export function contextBudget(model: ModelConfig) {
  const input = model.context.window_tokens - model.context.max_output_tokens - model.context.reserve_tokens;
  return {
    input_tokens: input,
    trigger_tokens: Math.floor(input * model.compaction.trigger_ratio),
    target_tokens: Math.floor(input * model.compaction.target_ratio),
  };
}

/**
 * Conservative local estimate used before a provider reports usage. It is
 * deliberately marked as an estimate and leaves the configured reserve intact.
 */
export function estimateText(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! > 0x2e80) wide++; else ascii++;
  }
  return Math.ceil(ascii / 4 + wide / 1.6);
}

export interface ContextEstimate {
  total: number;
  text: number;
  tool_schema: number;
  images: number;
  overhead: number;
  estimated: true;
}

export function estimateMessages(messages: readonly Message[], summary?: string, toolSchemaTokens = 0): ContextEstimate {
  let text = summary ? estimateText(summary) + 16 : 0;
  let images = 0;
  for (const message of messages) {
    text += estimateText(message.content) + 6;
    if (message.tool_calls) text += estimateText(JSON.stringify(message.tool_calls)) + 8;
    for (const image of message.images ?? []) images += Math.ceil((image.data.length * 0.75) / 750);
  }
  return {
    total: text + images + toolSchemaTokens, text, tool_schema: toolSchemaTokens, images,
    overhead: 8, estimated: true,
  };
}

export function usageFrom(input: number | null | undefined, output: number | null | undefined, source: string): Usage {
  return {
    input_tokens: input ?? null,
    output_tokens: output ?? null,
    total_tokens: input == null && output == null ? null : (input ?? 0) + (output ?? 0),
    estimated: false,
    source,
  };
}

export function mergeUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
    estimated: a.estimated || b.estimated,
    source: `${a.source}+${b.source}`,
  };
}
