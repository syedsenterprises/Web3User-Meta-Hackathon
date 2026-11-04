/**
 * Web3User Permission Lab - Local Preview & Meta Model API Bridge Server
 *
 * Serves the website-preview demonstration interface and provides a secure
 * backend proxy endpoint (/api/generate-policy) for the Meta Muse Spark assistant.
 *
 * SECURITY CONTRACT:
 * - MODEL_API_KEY is kept strictly on the backend and NEVER sent to the browser.
 * - Input size is bounded (max 32KB payload, max 2,000 characters prompt).
 * - If MODEL_API_KEY is not configured, the server operates in safe offline simulation mode,
 *   transparently labeling the proposal as offline simulation without failing.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MetaPolicyAssistant } from "../dist/meta-ai/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW_DIR = path.resolve(__dirname, "..", "website-preview");
const DEFAULT_PORT = parseInt(process.env.PORT || "3000", 10);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

export function createPreviewServer(options = {}) {
  const assistant = new MetaPolicyAssistant({
    apiKey: options.apiKey ?? process.env.MODEL_API_KEY ?? "",
    model: options.model ?? "muse-spark-1.3",
  });

  const server = http.createServer(async (req, res) => {
    // Enable CORS for local testing if needed
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // API: Status
    if (req.method === "GET" && pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "online",
          model: assistant.client.model,
          endpoint: "https://api.meta.ai/v1/chat/completions",
          hasApiKey: assistant.client.hasApiKey(),
        })
      );
      return;
    }

    // API: Generate Policy via Meta AI Assistant
    if (req.method === "POST" && pathname === "/api/generate-policy") {
      let body = "";
      const MAX_BODY_BYTES = 32 * 1024; // 32KB

      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload exceeds 32KB limit." }));
          req.destroy();
        }
      });

      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
          const refTime = typeof payload.referenceTimeSeconds === "number"
            ? payload.referenceTimeSeconds
            : Math.floor(Date.now() / 1000);

          if (!prompt) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Prompt is required and cannot be empty." }));
            return;
          }

          if (prompt.length > 2000) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Prompt exceeds the 2,000 character maximum limit." }));
            return;
          }

          // If live API key is configured, call Meta Muse Spark
          if (assistant.client.hasApiKey()) {
            try {
              const proposal = await assistant.generatePolicyProposal(prompt, {
                referenceTimeSeconds: refTime,
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ...proposal, isLiveApi: true }));
              return;
            } catch (apiErr) {
              const errorMessage = apiErr instanceof Error ? apiErr.message : "Unknown Meta AI error";
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: errorMessage,
                  isLiveApi: true,
                })
              );
              return;
            }
          }

          // Safe Offline Simulation Fallback when MODEL_API_KEY is not set
          const simulated = simulatePolicyFromPrompt(prompt, refTime);
          const validation = assistant.validateProposedPolicy(simulated.policy);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: validation.isValid,
              rawOutput: JSON.stringify(simulated, null, 2),
              policy: validation.policy,
              validationErrors: validation.errors,
              modelUsed: "muse-spark-1.3 (Simulated Offline Fallback)",
              explanation: simulated.explanation,
              isApproved: false,
              isLiveApi: false,
              note: "MODEL_API_KEY is not configured. Running in deterministic offline simulation mode.",
            })
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Malformed JSON request body." }));
        }
      });
      return;
    }

    // Static File Serving
    let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    if (safePath === "/" || safePath === "\\") {
      safePath = "/index.html";
    }

    const filePath = path.join(PREVIEW_DIR, safePath);
    if (!filePath.startsWith(PREVIEW_DIR)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  return server;
}

/**
 * Deterministic offline simulation helper when MODEL_API_KEY is absent.
 */
function simulatePolicyFromPrompt(prompt, refTime) {
  const pLower = prompt.toLowerCase();

  // Extract address if present in prompt
  const addrMatch = prompt.match(/0x[a-fA-F0-9]{40}/g);
  const target = addrMatch?.[0] || "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC
  const recipient = addrMatch?.[1] || "0x2222222222222222222222222222222222222222";

  // Extract amount heuristics
  let maxAmount = "1000000000"; // 1000 USDC default
  let budgetConfig = undefined;

  if (pLower.includes("0.25 eth") || pLower.includes("0.25")) {
    maxAmount = "250000000000000000"; // 0.25 * 10^18 wei
  } else if (pLower.includes("500 usdc") || pLower.includes("500")) {
    maxAmount = "500000000"; // 500 * 10^6
  } else if (pLower.includes("100 usdc") || pLower.includes("100")) {
    maxAmount = "100000000";
  }

  if (pLower.includes("daily") || pLower.includes("day")) {
    const dailyCap = pLower.includes("2 eth") || pLower.includes("2")
      ? "2000000000000000000"
      : "2000000000";
    budgetConfig = {
      window: "DAILY",
      maxCumulativeAmount: dailyCap,
    };
  } else if (pLower.includes("hourly") || pLower.includes("hour")) {
    budgetConfig = {
      window: "HOURLY",
      maxCumulativeAmount: "1000000000",
    };
  }

  const policy = {
    version: 1,
    policyId: "ai-synthesized-policy-" + Math.floor(refTime % 10000),
    allowedTarget: target,
    allowedRecipient: recipient,
    allowedSelector: "0xa9059cbb",
    maxAmount,
    validFrom: refTime,
    expiresAt: refTime + 86400,
    revoked: false,
    ...(budgetConfig ? { budget: budgetConfig } : {}),
  };

  return {
    policy,
    explanation: `Synthesized policy: ${budgetConfig ? `${budgetConfig.window} cumulative limit ${budgetConfig.maxCumulativeAmount}` : "per-action limit"} for ERC-20 transfer to ${recipient}.`,
  };
}

// Start standalone server when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const server = createPreviewServer();
  server.listen(DEFAULT_PORT, () => {
    console.log(`[Web3User Preview Server] Running at http://localhost:${DEFAULT_PORT}`);
    console.log(`[Web3User Preview Server] Meta AI Status: ${process.env.MODEL_API_KEY ? "Live API (MODEL_API_KEY set)" : "Offline Simulation (MODEL_API_KEY absent)"}`);
  });
}
