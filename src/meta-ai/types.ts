/**
 * Web3User Permission Lab - Meta Model API Integration Types
 *
 * Official Meta AI Model Endpoint Specification:
 * - Base URL: https://api.meta.ai/v1
 * - Endpoint: /chat/completions
 * - Model: muse-spark-1.3
 * - Auth: Bearer token (MODEL_API_KEY)
 */

import type { DemoPolicy } from "../policy.js";

export interface MetaAiClientConfig {
  /** Meta AI API Bearer token. Falls back to process.env.MODEL_API_KEY if omitted. */
  apiKey?: string;
  /** Meta AI API base URL. Defaults to https://api.meta.ai/v1 */
  baseUrl?: string;
  /** Model identifier. Defaults to muse-spark-1.3 */
  model?: string;
  /** Request timeout in milliseconds. Defaults to 15,000ms. */
  timeoutMs?: number;
  /** Maximum allowable prompt length in characters. Defaults to 2,000. */
  maxPromptLength?: number;
  /** Custom fetch implementation for testing and mocking. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Structured result of an AI policy generation request.
 *
 * SECURITY INVARIANT:
 * Proposals are NEVER automatically approved, loaded, or enforced.
 * `isApproved` is strictly `false` upon generation and requires explicit human approval.
 */
export interface PolicyProposalResult {
  readonly success: boolean;
  readonly rawOutput: string;
  readonly policy: DemoPolicy | null;
  readonly validationErrors: readonly string[];
  readonly modelUsed: string;
  readonly explanation?: string;
  readonly isApproved: false;
}

// ============================================================================
// Error Contract
// ============================================================================

export class MetaAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaAiError";
  }
}

export class MetaAiAuthError extends MetaAiError {
  constructor(message: string = "Meta AI authentication failed: missing or invalid credentials") {
    super(message);
    this.name = "MetaAiAuthError";
  }
}

export class MetaAiRateLimitError extends MetaAiError {
  constructor(message: string = "Meta AI rate limit exceeded (HTTP 429)") {
    super(message);
    this.name = "MetaAiRateLimitError";
  }
}

export class MetaAiTimeoutError extends MetaAiError {
  constructor(message: string = "Meta AI request timed out") {
    super(message);
    this.name = "MetaAiTimeoutError";
  }
}

export class MetaAiInputExceededError extends MetaAiError {
  constructor(length: number, max: number) {
    super(`Prompt length (${length} characters) exceeds the maximum allowed limit of ${max} characters.`);
    this.name = "MetaAiInputExceededError";
  }
}

export class MetaAiResponseError extends MetaAiError {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "MetaAiResponseError";
    this.statusCode = statusCode;
  }
}
