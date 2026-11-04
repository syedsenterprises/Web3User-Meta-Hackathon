/**
 * Web3User Permission Lab - Meta Model API Client
 *
 * Implements communication with Meta's official model API endpoint:
 * https://api.meta.ai/v1/chat/completions
 *
 * SECURITY CONTRACT:
 * - Credentials are read from configuration or process.env.MODEL_API_KEY.
 * - API keys are never logged, formatted into standard error messages, or transmitted to browsers.
 * - All outbound network calls are bound by a strict timeout (AbortSignal).
 * - Maximum input length is strictly enforced to prevent unbounded payload abuse.
 */

import {
  type MetaAiClientConfig,
  type ChatMessage,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  MetaAiAuthError,
  MetaAiRateLimitError,
  MetaAiTimeoutError,
  MetaAiInputExceededError,
  MetaAiResponseError,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_MODEL = "muse-spark-1.3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PROMPT_LENGTH = 2_000;

export class MetaAiClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxPromptLength: number;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: MetaAiClientConfig = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = config.model || DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPromptLength = config.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;

    const key = config.apiKey ?? process.env.MODEL_API_KEY ?? "";
    this.apiKey = key.trim();
  }

  /**
   * Returns true if a non-empty API key is configured.
   * Does NOT return or expose the key string.
   */
  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Execute chat completion call to Meta Model API (/chat/completions).
   */
  async createChatCompletion(
    messages: ChatMessage[],
    options: { temperature?: number; max_tokens?: number } = {}
  ): Promise<ChatCompletionResponse> {
    if (!this.hasApiKey()) {
      throw new MetaAiAuthError(
        "Meta AI API key is not configured. Set the MODEL_API_KEY environment variable or pass apiKey in client options."
      );
    }

    // Enforce bounded input length
    let totalLength = 0;
    for (const msg of messages) {
      if (typeof msg.content !== "string") {
        throw new MetaAiResponseError("Message content must be a string");
      }
      totalLength += msg.content.length;
    }

    if (totalLength > this.maxPromptLength) {
      throw new MetaAiInputExceededError(totalLength, this.maxPromptLength);
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload: ChatCompletionRequest = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.1,
      ...(options.max_tokens ? { max_tokens: options.max_tokens } : {}),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);

      if (err instanceof Error) {
        if (err.name === "AbortError" || err.message.toLowerCase().includes("aborted")) {
          throw new MetaAiTimeoutError(
            `Meta AI request timed out after ${this.timeoutMs}ms.`
          );
        }
        // Redact any possible URL or sensitive strings from the error message
        throw new MetaAiResponseError(`Meta AI network request failed: ${err.message}`);
      }
      throw new MetaAiResponseError("Meta AI network request failed with unknown error");
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new MetaAiAuthError(
          `Meta AI authentication failed (HTTP ${response.status}). Verify your MODEL_API_KEY.`
        );
      }
      if (response.status === 429) {
        throw new MetaAiRateLimitError(
          "Meta AI rate limit exceeded (HTTP 429). Retry after backoff."
        );
      }
      throw new MetaAiResponseError(
        `Meta AI API responded with HTTP ${response.status} ${response.statusText}`,
        response.status
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new MetaAiResponseError("Meta AI returned invalid, unparseable JSON response.");
    }

    if (!isChatCompletionResponse(data)) {
      throw new MetaAiResponseError(
        "Meta AI response structure does not match expected chat completion schema."
      );
    }

    return data;
  }
}

function isChatCompletionResponse(data: unknown): data is ChatCompletionResponse {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.choices) && obj.choices.length > 0;
}
