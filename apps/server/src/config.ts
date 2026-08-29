import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Reads the OpenCode Go API key from the local opencode auth store so we
 * never hardcode secrets. Override with OPENCODE_GO_API_KEY if desired.
 */
function loadOpenCodeGoApiKey(): string {
  if (process.env.OPENCODE_GO_API_KEY) {
    return process.env.OPENCODE_GO_API_KEY;
  }
  const authPath = join(homedir(), ".local/share/opencode/auth.json");
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >;
    const key = auth["opencode-go"]?.key;
    if (!key) {
      throw new Error("opencode-go entry has no key");
    }
    return key;
  } catch (err) {
    throw new Error(
      `Could not load OpenCode Go API key from ${authPath}. Set OPENCODE_GO_API_KEY instead. Cause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export const config = {
  trueforgeBaseUrl: env("TRUEFORGE_BASE_URL", "http://127.0.0.1:8790"),

  /** Host/port for this process's MCP endpoint (the Android Tool Bridge in later milestones). */
  mcpHost: env("BRIDGE_MCP_HOST", "127.0.0.1"),
  mcpPort: Number.parseInt(env("BRIDGE_MCP_PORT", "8791"), 10),

  modelProviderName: env("MODEL_PROVIDER_NAME", "opencode-go"),
  /**
   * Vision-capable by default. The text-only `deepseek-v4-flash` rejects an
   * `image_url` content block outright (`400 Model only supports text input`)
   * and TrueForge dynamic sub-agents inherit the parent's model, so choosing a
   * text-only main model would make a vision sub-agent impossible. The two
   * variants bill the same, so there is no reason to run blind.
   */
  mainModelId: env("MAIN_MODEL_ID", "deepseek-v4-flash-vision-exp"),
  /** Model behind `inspect_screen_visually`. Same family unless overridden. */
  visionModelId: env("VISION_MODEL_ID", "deepseek-v4-flash-vision-exp"),

  agentName: env("AGENT_NAME", "android-operator-dev"),
} as const;

export function openCodeGoApiKey(): string {
  return loadOpenCodeGoApiKey();
}

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
