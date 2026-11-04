/**
 * Web3User Permission Lab - Preview Server & Meta Model Bridge Tests
 *
 * Verifies that the preview server correctly exposes static files and the
 * /api/generate-policy and /api/status bridge endpoints with proper bounding
 * and security constraints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createPreviewServer } from "../../scripts/preview-server.mjs";

describe("Preview Server & Meta AI Bridge (scripts/preview-server.mjs)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createPreviewServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /api/status returns model info and credential presence status without leaking keys", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.status).toBe("online");
    expect(data.model).toBe("muse-spark-1.3");
    expect(data.endpoint).toBe("https://api.meta.ai/v1/chat/completions");
    expect(typeof data.hasApiKey).toBe("boolean");
    // Ensure no secret or key field exists in status output
    expect((data as any).apiKey).toBeUndefined();
    expect((data as any).MODEL_API_KEY).toBeUndefined();
  });

  it("POST /api/generate-policy returns valid simulated proposal when MODEL_API_KEY is absent", async () => {
    const res = await fetch(`${baseUrl}/api/generate-policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Allow agent to spend at most 0.25 ETH with daily budget of 2 ETH",
        referenceTimeSeconds: 1800000000,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.isApproved).toBe(false); // Proposals are strictly unapproved
    expect(data.policy).not.toBeNull();
    expect(data.policy.version).toBe(1);
    expect(data.policy.allowedSelector).toBe("0xa9059cbb");
    expect(data.policy.maxAmount).toBe("250000000000000000"); // 0.25 ETH in wei
    expect(data.policy.budget.window).toBe("DAILY");
    expect(data.isLiveApi).toBe(false);
    expect(data.note).toContain("MODEL_API_KEY is not configured");
  });

  it("POST /api/generate-policy fails closed with HTTP 400 on empty prompt", async () => {
    const res = await fetch(`${baseUrl}/api/generate-policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Prompt is required");
  });

  it("POST /api/generate-policy fails closed with HTTP 400 when prompt exceeds 2,000 characters", async () => {
    const longPrompt = "X".repeat(2001);
    const res = await fetch(`${baseUrl}/api/generate-policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: longPrompt }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("2,000 character maximum limit");
  });

  it("GET /index.html successfully serves demonstration interface with AI assistant section", async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("AI Natural-Language Policy Assistant");
    expect(html).toContain("muse-spark-1.3");
    expect(html).toContain("ai-prompt-input");
    expect(html).toContain("btn-ai-generate");
    expect(html).toContain("btn-ai-approve");
  });

  it("prevents directory traversal attacks outside preview directory", async () => {
    const res = await fetch(`${baseUrl}/../../package.json`);
    // Path normalization strips traversal and serves index or returns 404
    expect([200, 403, 404]).toContain(res.status);
    const text = await res.text();
    // Must NOT serve package.json containing scripts
    expect(text).not.toContain('"scripts":');
  });
});
