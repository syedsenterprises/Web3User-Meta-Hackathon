/**
 * Web3User Permission Lab - Meta Muse Spark AI Policy Assistant
 *
 * Translates natural language permission requirements into strongly-typed,
 * schema-validated Web3User DemoPolicy structures.
 *
 * STRICT SECURITY INVARIANTS:
 * 1. AI output is treated as untrusted input.
 * 2. AI CANNOT approve transactions.
 * 3. AI CANNOT execute transactions.
 * 4. AI CANNOT sign authorization receipts.
 * 5. AI CANNOT modify existing policy stores directly.
 * 6. AI CANNOT bypass deterministic policy validation.
 * 7. AI CANNOT change witness state.
 * 8. All proposed policies must pass existing Web3User schema validation (normalizeDemoPolicy).
 * 9. Invalid or malformed model output fails closed immediately.
 * 10. The existing deterministic policy engine remains the sole enforcement authority.
 */

import {
  type DemoPolicy,
  type PolicyBudgetConfig,
  normalizeDemoPolicy,
  isUint256String,
} from "../policy.js";
import { MetaAiClient } from "./meta-client.js";
import {
  type MetaAiClientConfig,
  type PolicyProposalResult,
  type ChatMessage,
} from "./types.js";

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SELECTOR_REGEX = /^0x[a-fA-F0-9]{8}$/;
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const MAX_UINT256 = (1n << 256n) - 1n;

const SYSTEM_PROMPT = `You are the Web3User Policy Assistant powered by Meta's muse-spark-1.3 model.
Your task is to translate natural language transaction permission requirements into a structured, deterministic Web3User DemoPolicy JSON object.

Output MUST be a JSON object with this exact shape:
{
  "policy": {
    "version": 1,
    "policyId": "kebab-case-string-max-128-chars",
    "allowedTarget": "0x40HexCharactersContractAddress",
    "allowedRecipient": "0x40HexCharactersRecipientAddress",
    "allowedSelector": "0xa9059cbb",
    "maxAmount": "base10IntegerStringUnits",
    "validFrom": 1800000000,
    "expiresAt": 1800086400,
    "revoked": false,
    "budget": {
      "window": "HOURLY" or "DAILY",
      "maxCumulativeAmount": "base10IntegerStringUnits"
    }
  },
  "explanation": "Brief plain-text explanation of the synthesized rules."
}

CRITICAL RULES:
- version MUST be exactly 1.
- allowedTarget and allowedRecipient MUST be valid 20-byte Ethereum hex addresses starting with 0x (42 characters total).
- allowedSelector MUST be exactly "0xa9059cbb" (ERC-20 transfer).
- maxAmount MUST be a non-negative base-10 integer string in base units (e.g., "1000000" for 1 USDC or "250000000000000000" for 0.25 ETH in wei). Never negative, never scientific notation, never decimal.
- expiresAt MUST be strictly greater than validFrom.
- revoked MUST be false.
- budget is optional. If the user mentions hourly or daily cumulative budgets, include budget with window ("HOURLY" or "DAILY") and maxCumulativeAmount.
- Output ONLY the JSON block. Do not add conversational markdown outside the JSON.`;

export interface PolicyValidationDetail {
  isValid: boolean;
  policy: DemoPolicy | null;
  errors: string[];
}

export class MetaPolicyAssistant {
  readonly client: MetaAiClient;

  constructor(clientOrConfig?: MetaAiClient | MetaAiClientConfig) {
    if (clientOrConfig instanceof MetaAiClient) {
      this.client = clientOrConfig;
    } else {
      this.client = new MetaAiClient(clientOrConfig);
    }
  }

  /**
   * Generates a policy proposal from a natural-language description using Meta Muse Spark.
   *
   * SECURITY GUARANTEE:
   * Returns a proposal with `isApproved: false`.
   * Never mutates existing state or policy engines.
   */
  async generatePolicyProposal(
    naturalLanguagePrompt: string,
    options: {
      referenceTimeSeconds?: number;
      defaultPolicyId?: string;
    } = {}
  ): Promise<PolicyProposalResult> {
    const trimmedPrompt = naturalLanguagePrompt.trim();
    if (!trimmedPrompt) {
      return {
        success: false,
        rawOutput: "",
        policy: null,
        validationErrors: ["Prompt cannot be empty."],
        modelUsed: this.client.model,
        isApproved: false,
      };
    }

    const refTime = options.referenceTimeSeconds ?? Math.floor(Date.now() / 1000);
    const userMessageContent = `Current reference timestamp: ${refTime} (validFrom should default to ${refTime}, expiresAt should default to ${refTime + 86400} unless specified).
${options.defaultPolicyId ? `Suggested policyId: ${options.defaultPolicyId}` : ""}

User Requirement:
"${trimmedPrompt}"`;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessageContent },
    ];

    const response = await this.client.createChatCompletion(messages, {
      temperature: 0.1,
    });

    const choice = response.choices[0];
    const rawOutput = choice?.message?.content?.trim() || "";

    if (!rawOutput) {
      return {
        success: false,
        rawOutput: "",
        policy: null,
        validationErrors: ["Model returned an empty response."],
        modelUsed: response.model,
        isApproved: false,
      };
    }

    // Extract and parse JSON
    const parsedJson = extractJson(rawOutput);
    if (!parsedJson) {
      return {
        success: false,
        rawOutput,
        policy: null,
        validationErrors: [
          "Failed to parse JSON from Meta model output. The response did not contain a valid JSON object.",
        ],
        modelUsed: response.model,
        isApproved: false,
      };
    }

    // Determine candidate policy object: could be wrapped in { policy: ... } or raw
    const candidatePolicy = isRecord(parsedJson) && "policy" in parsedJson
      ? parsedJson.policy
      : parsedJson;

    const explanation = isRecord(parsedJson) && typeof parsedJson.explanation === "string"
      ? parsedJson.explanation
      : undefined;

    // Deep validation using project validator and detailed invariant checker
    const validation = this.validateProposedPolicy(candidatePolicy);

    if (!validation.isValid || !validation.policy) {
      return {
        success: false,
        rawOutput,
        policy: null,
        validationErrors: validation.errors,
        modelUsed: response.model,
        explanation,
        isApproved: false,
      };
    }

    return {
      success: true,
      rawOutput,
      policy: validation.policy,
      validationErrors: [],
      modelUsed: response.model,
      explanation,
      isApproved: false,
    };
  }

  /**
   * Deeply validates any candidate policy object against Web3User DemoPolicy invariants.
   * Returns a canonical DemoPolicy if valid, or a detailed list of human-readable errors.
   */
  validateProposedPolicy(input: unknown): PolicyValidationDetail {
    const errors: string[] = [];

    if (!isRecord(input)) {
      return {
        isValid: false,
        policy: null,
        errors: ["Policy must be a non-null JSON object."],
      };
    }

    // Check version
    if (input.version !== 1) {
      errors.push(`version must be exactly 1, received: ${JSON.stringify(input.version)}`);
    }

    // Check policyId
    if (typeof input.policyId !== "string" || input.policyId.trim().length === 0) {
      errors.push("policyId must be a non-empty string");
    } else if (input.policyId.length > 128) {
      errors.push(`policyId exceeds maximum length of 128 characters (${input.policyId.length})`);
    }

    // Check allowedTarget
    if (typeof input.allowedTarget !== "string" || !ADDRESS_REGEX.test(input.allowedTarget)) {
      errors.push(
        `allowedTarget must be a valid 20-byte hex address (0x followed by 40 hex characters), received: ${JSON.stringify(input.allowedTarget)}`
      );
    }

    // Check allowedRecipient
    if (typeof input.allowedRecipient !== "string" || !ADDRESS_REGEX.test(input.allowedRecipient)) {
      errors.push(
        `allowedRecipient must be a valid 20-byte hex address (0x followed by 40 hex characters), received: ${JSON.stringify(input.allowedRecipient)}`
      );
    }

    // Check allowedSelector
    if (typeof input.allowedSelector !== "string" || !SELECTOR_REGEX.test(input.allowedSelector)) {
      errors.push(
        `allowedSelector must be a valid 4-byte hex selector (0x followed by 8 hex characters), received: ${JSON.stringify(input.allowedSelector)}`
      );
    } else if (input.allowedSelector.toLowerCase() !== ERC20_TRANSFER_SELECTOR) {
      errors.push(
        `allowedSelector must be exactly '${ERC20_TRANSFER_SELECTOR}' (ERC-20 transfer(address,uint256)), received: ${input.allowedSelector}`
      );
    }

    // Check maxAmount
    if (typeof input.maxAmount !== "string" || !isUint256String(input.maxAmount)) {
      errors.push(
        `maxAmount must be a non-negative base-10 uint256 string (<= 2^256-1), received: ${JSON.stringify(input.maxAmount)}`
      );
    }

    // Check validFrom & expiresAt
    const validFrom = input.validFrom;
    const expiresAt = input.expiresAt;

    if (typeof validFrom !== "number" || !Number.isSafeInteger(validFrom) || validFrom < 0) {
      errors.push(`validFrom must be a non-negative safe integer Unix timestamp, received: ${JSON.stringify(validFrom)}`);
    }

    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      errors.push(`expiresAt must be a non-negative safe integer Unix timestamp, received: ${JSON.stringify(expiresAt)}`);
    } else if (typeof validFrom === "number" && Number.isSafeInteger(validFrom) && expiresAt <= validFrom) {
      errors.push(`expiresAt (${expiresAt}) must be strictly greater than validFrom (${validFrom})`);
    }

    // Check revoked
    if (typeof input.revoked !== "boolean") {
      errors.push(`revoked must be a boolean (false), received: ${JSON.stringify(input.revoked)}`);
    }

    // Check optional budget
    if ("budget" in input && input.budget !== undefined && input.budget !== null) {
      if (!isRecord(input.budget)) {
        errors.push("budget must be an object if specified");
      } else {
        const { window, maxCumulativeAmount } = input.budget;
        if (window !== "HOURLY" && window !== "DAILY") {
          errors.push(`budget.window must be either 'HOURLY' or 'DAILY', received: ${JSON.stringify(window)}`);
        }
        if (typeof maxCumulativeAmount !== "string" || !isUint256String(maxCumulativeAmount)) {
          errors.push(
            `budget.maxCumulativeAmount must be a non-negative base-10 uint256 string, received: ${JSON.stringify(maxCumulativeAmount)}`
          );
        }
      }
    }

    // If errors were found, fail closed
    if (errors.length > 0) {
      return {
        isValid: false,
        policy: null,
        errors,
      };
    }

    // Finally verify through project's canonical normalizeDemoPolicy
    const canonical = normalizeDemoPolicy(input);
    if (!canonical) {
      return {
        isValid: false,
        policy: null,
        errors: ["Policy failed project canonical normalization."],
      };
    }

    return {
      isValid: true,
      policy: canonical,
      errors: [],
    };
  }

  /**
   * Explicit human approval guardrail.
   *
   * Converts a verified proposal into an active DemoPolicy.
   * Throws if the proposal is unsuccessful, missing a verified policy, or invalid.
   */
  static approvePolicyProposal(proposal: PolicyProposalResult): DemoPolicy {
    if (!proposal.success || !proposal.policy) {
      throw new Error(
        `Cannot approve invalid policy proposal: ${proposal.validationErrors.join("; ") || "Unknown validation error"}`
      );
    }
    return proposal.policy;
  }
}

// ============================================================================
// Helper Utilities
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJson(text: string): unknown | null {
  // 1. Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Continue to markdown extraction
  }

  // 2. Try markdown json code block ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // Continue
    }
  }

  // 3. Try finding outermost { ... }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}
