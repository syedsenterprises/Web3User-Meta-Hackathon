/**
 * Web3User Permission Lab - Meta Muse Spark AI Policy Assistant Tests
 *
 * Validates Meta Model API integration, input bounding, error handling,
 * strict schema validation, fail-closed mechanics, and security invariants.
 *
 * NOTE: All tests in this suite mock the Meta Model API network layer.
 * No live outbound network requests or live API calls are executed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MetaAiClient,
  MetaPolicyAssistant,
  MetaAiAuthError,
  MetaAiRateLimitError,
  MetaAiTimeoutError,
  MetaAiInputExceededError,
  MetaAiResponseError,
  type ChatCompletionResponse,
} from "../../src/meta-ai/index.js";
import { evaluate, type DemoPolicy } from "../../src/policy.js";

function createMockResponse(status: number, body: unknown, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as Response;
}

function createSuccessChatResponse(content: string, model = "muse-spark-1.3"): ChatCompletionResponse {
  return {
    id: "chatcmpl-mock-test-1",
    object: "chat.completion",
    created: 1800000000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

const VALID_SAMPLE_POLICY: DemoPolicy = {
  version: 1,
  policyId: "agent-usdc-daily-cap",
  allowedTarget: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  allowedRecipient: "0x2222222222222222222222222222222222222222",
  allowedSelector: "0xa9059cbb",
  maxAmount: "250000000",
  validFrom: 1800000000,
  expiresAt: 1800086400,
  revoked: false,
  budget: {
    window: "DAILY",
    maxCumulativeAmount: "2000000000",
  },
};

describe("Meta Model API Client (src/meta-ai/meta-client.ts)", () => {
  const testKey = "meta-test-bearer-token-12345";

  it("throws MetaAiAuthError when API key is missing", async () => {
    const client = new MetaAiClient({ apiKey: "", fetchFn: vi.fn() });
    await expect(
      client.createChatCompletion([{ role: "user", content: "test prompt" }])
    ).rejects.toThrow(MetaAiAuthError);
  });

  it("sends request with correct default model (muse-spark-1.3) and Bearer auth header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return createMockResponse(200, createSuccessChatResponse(JSON.stringify(VALID_SAMPLE_POLICY)));
    });

    const client = new MetaAiClient({ apiKey: testKey, fetchFn: mockFetch as any });
    await client.createChatCompletion([{ role: "user", content: "hello" }]);

    expect(capturedUrl).toBe("https://api.meta.ai/v1/chat/completions");
    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${testKey}`);
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedBody.model).toBe("muse-spark-1.3");
  });

  it("enforces bounded input length and rejects prompts exceeding maxPromptLength", async () => {
    const client = new MetaAiClient({ apiKey: testKey, maxPromptLength: 50, fetchFn: vi.fn() });
    const longPrompt = "A".repeat(51);

    await expect(
      client.createChatCompletion([{ role: "user", content: longPrompt }])
    ).rejects.toThrow(MetaAiInputExceededError);
  });

  it("handles request timeout and throws MetaAiTimeoutError", async () => {
    const mockFetch = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const client = new MetaAiClient({ apiKey: testKey, fetchFn: mockFetch as any });
    await expect(
      client.createChatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow(MetaAiTimeoutError);
  });

  it("maps HTTP 401/403 to MetaAiAuthError and sanitizes sensitive credentials", async () => {
    const mockFetch = vi.fn(async () => createMockResponse(401, { error: "unauthorized" }, "Unauthorized"));
    const client = new MetaAiClient({ apiKey: testKey, fetchFn: mockFetch as any });

    try {
      await client.createChatCompletion([{ role: "user", content: "test" }]);
      expect.fail("Expected MetaAiAuthError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(MetaAiAuthError);
      expect(err.message).toContain("401");
      expect(err.message).not.toContain(testKey); // never leaks key
    }
  });

  it("maps HTTP 429 to MetaAiRateLimitError", async () => {
    const mockFetch = vi.fn(async () => createMockResponse(429, { error: "rate limit exceeded" }, "Too Many Requests"));
    const client = new MetaAiClient({ apiKey: testKey, fetchFn: mockFetch as any });

    await expect(
      client.createChatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow(MetaAiRateLimitError);
  });

  it("handles network failure and wraps in MetaAiResponseError", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    });
    const client = new MetaAiClient({ apiKey: testKey, fetchFn: mockFetch as any });

    await expect(
      client.createChatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow(MetaAiResponseError);
  });

  it("handles malformed non-JSON HTTP response body", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    } as unknown as Response));

    const client = new MetaAiClient({ apiKey: testKey, fetchFn: mockFetch as any });
    await expect(
      client.createChatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow(MetaAiResponseError);
  });
});

describe("Meta Policy Assistant (src/meta-ai/policy-assistant.ts)", () => {
  const testKey = "meta-test-bearer-token-12345";

  it("successfully synthesizes and validates a policy from natural-language output", async () => {
    const modelOutput = JSON.stringify({
      policy: VALID_SAMPLE_POLICY,
      explanation: "Allows spending at most 0.25 USDC per trade with a 2 USDC daily budget cap.",
    });

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(modelOutput))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal(
      "Allow agent to spend up to 0.25 USDC with daily cap of 2 USDC",
      { referenceTimeSeconds: 1800000000 }
    );

    expect(proposal.success).toBe(true);
    expect(proposal.isApproved).toBe(false); // MUST remain unapproved until explicit human action
    expect(proposal.policy).not.toBeNull();
    expect(proposal.policy?.allowedTarget).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(proposal.policy?.budget?.window).toBe("DAILY");
    expect(proposal.policy?.budget?.maxCumulativeAmount).toBe("2000000000");
    expect(proposal.validationErrors).toHaveLength(0);
  });

  it("successfully parses policy wrapped in markdown json fences (```json ... ```)", async () => {
    const modelOutput = `Here is your synthesized Web3User policy:
\`\`\`json
${JSON.stringify({ policy: VALID_SAMPLE_POLICY, explanation: "Parsed from markdown block" }, null, 2)}
\`\`\`
Let me know if you need changes.`;

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(modelOutput))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test markdown fence parsing");

    expect(proposal.success).toBe(true);
    expect(proposal.policy).not.toBeNull();
    expect(proposal.policy?.policyId).toBe("agent-usdc-daily-cap");
  });

  it("fails closed when model output is invalid JSON", async () => {
    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse("This is plain text with no JSON object."))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Invalid response test");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors[0]).toContain("Failed to parse JSON");
    expect(proposal.isApproved).toBe(false);
  });

  it("fails closed when required fields are missing", async () => {
    const incompletePolicy = {
      version: 1,
      policyId: "missing-fields",
      // missing allowedTarget, allowedRecipient, allowedSelector, etc.
    };

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: incompletePolicy })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test missing fields");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors.some((e) => e.includes("allowedTarget"))).toBe(true);
    expect(proposal.validationErrors.some((e) => e.includes("allowedRecipient"))).toBe(true);
  });

  it("fails closed when contract address is invalid (not 20-byte hex)", async () => {
    const invalidAddressPolicy = {
      ...VALID_SAMPLE_POLICY,
      allowedTarget: "0xInvalidShortAddress",
    };

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: invalidAddressPolicy })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test invalid address");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors.some((e) => e.includes("allowedTarget must be a valid 20-byte hex address"))).toBe(true);
  });

  it("fails closed on negative amount limits", async () => {
    const negativeAmountPolicy = {
      ...VALID_SAMPLE_POLICY,
      maxAmount: "-500",
    };

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: negativeAmountPolicy })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test negative amount");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors.some((e) => e.includes("maxAmount must be a non-negative"))).toBe(true);
  });

  it("fails closed on excessive spending limits exceeding uint256 max", async () => {
    const excessiveAmount = "115792089237316195423570985008687907853269984665640564039457584007913129639936"; // 2^256
    const overflowPolicy = {
      ...VALID_SAMPLE_POLICY,
      maxAmount: excessiveAmount,
    };

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: overflowPolicy })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test uint256 overflow");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors.some((e) => e.includes("maxAmount must be a non-negative base-10 uint256 string"))).toBe(true);
  });

  it("fails closed when expiresAt is not strictly greater than validFrom", async () => {
    const invalidTimePolicy = {
      ...VALID_SAMPLE_POLICY,
      validFrom: 1800086400,
      expiresAt: 1800000000, // in the past relative to validFrom
    };

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: invalidTimePolicy })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test inverted timestamps");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors.some((e) => e.includes("expiresAt") && e.includes("strictly greater"))).toBe(true);
  });

  it("fails closed when budget window is invalid", async () => {
    const invalidBudgetPolicy = {
      ...VALID_SAMPLE_POLICY,
      budget: {
        window: "MONTHLY", // only HOURLY and DAILY supported
        maxCumulativeAmount: "100000",
      },
    };

    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: invalidBudgetPolicy })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test invalid budget window");

    expect(proposal.success).toBe(false);
    expect(proposal.policy).toBeNull();
    expect(proposal.validationErrors.some((e) => e.includes("budget.window"))).toBe(true);
  });
});

describe("Strict Security Invariants & Human Approval Guardrails", () => {
  const testKey = "meta-test-bearer-token-12345";

  it("INVARIANT: AI proposal cannot approve or execute transactions directly", async () => {
    const mockFetch = vi.fn(async () =>
      createMockResponse(200, createSuccessChatResponse(JSON.stringify({ policy: VALID_SAMPLE_POLICY })))
    );

    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: mockFetch as any });
    const proposal = await assistant.generatePolicyProposal("Test unapproved proposal");

    // 1. The proposal object has no execute() or approve() method
    expect((proposal as any).approve).toBeUndefined();
    expect((proposal as any).execute).toBeUndefined();
    expect(proposal.isApproved).toBe(false);

    // 2. An unapproved proposal cannot be passed directly into evaluateDemoPolicy without manual extraction
    // And even if the proposed policy is evaluated deterministically, evaluating a policy does NOT sign or execute transactions
    const evalResult = evaluate(
      proposal.policy!,
      {
        target: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        amount: "250000000",
        calldata: "0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000ee6b280", // 250000000
      },
      { nowSeconds: 1800000100 }
    );

    expect(evalResult.decision).toBe("ALLOW");
    // Evaluation decision is pure data; no signing key or transaction execution is performed
  });

  it("INVARIANT: approvePolicyProposal throws if proposal failed validation", () => {
    const failedProposal = {
      success: false,
      rawOutput: "bad output",
      policy: null,
      validationErrors: ["Invalid syntax"],
      modelUsed: "muse-spark-1.3",
      isApproved: false as const,
    };

    expect(() => MetaPolicyAssistant.approvePolicyProposal(failedProposal)).toThrow(
      "Cannot approve invalid policy proposal"
    );
  });

  it("INVARIANT: approvePolicyProposal returns the verified policy only upon explicit invocation", () => {
    const validProposal = {
      success: true,
      rawOutput: JSON.stringify(VALID_SAMPLE_POLICY),
      policy: VALID_SAMPLE_POLICY,
      validationErrors: [],
      modelUsed: "muse-spark-1.3",
      isApproved: false as const,
    };

    const approved = MetaPolicyAssistant.approvePolicyProposal(validProposal);
    expect(approved).toEqual(VALID_SAMPLE_POLICY);
  });

  it("INVARIANT: AI module has zero access to cryptographic witness or Ed25519 signing keys", () => {
    const assistant = new MetaPolicyAssistant({ apiKey: testKey, fetchFn: vi.fn() });

    // Ensure assistant instance does not expose private keys, signers, or witness adapters
    expect((assistant as any).privateKey).toBeUndefined();
    expect((assistant as any).signer).toBeUndefined();
    expect((assistant as any).witness).toBeUndefined();
    expect((assistant as any).signReceipt).toBeUndefined();
  });

  it("INVARIANT: Deterministic policy engine rejects actions that violate the synthesized policy", () => {
    // Even if an AI creates a policy, deterministic enforcement strictly blocks actions exceeding limits
    const policy: DemoPolicy = {
      ...VALID_SAMPLE_POLICY,
      maxAmount: "100", // strictly 100 base units
    };

    const exceedingAction = {
      target: policy.allowedTarget,
      amount: "101",
      // calldata for 101 units
      calldata: "0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000065",
    };

    const evalResult = evaluate(policy, exceedingAction, { nowSeconds: 1800000100 });
    expect(evalResult.decision).toBe("DENY");
    expect(evalResult.reasons).toContain("Amount exceeds the per-action policy limit.");
  });
});
