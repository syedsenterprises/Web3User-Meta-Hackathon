/**
 * Web3User Permission Lab - Preview Server Type Declarations
 *
 * Provides accurate TypeScript declaration typings for scripts/preview-server.mjs.
 */

import type { Server } from "node:http";

export interface PreviewServerOptions {
  /** Optional Meta AI API key. Falls back to process.env.MODEL_API_KEY. */
  apiKey?: string;
  /** Optional Meta model identifier. Defaults to "muse-spark-1.3". */
  model?: string;
}

/**
 * Creates and configures the HTTP server for website preview and Meta AI bridge.
 *
 * @param options - Server configuration options.
 * @returns Configured Node.js HTTP Server instance.
 */
export function createPreviewServer(options?: PreviewServerOptions): Server;
