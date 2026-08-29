/**
 * Reasoning effort, as a runtime setting rather than a constant.
 *
 * Two independent consumers spend reasoning tokens: the operator agent (via
 * the manifest's `model.params.reasoningEffort`, which TrueForge forwards to
 * the provider) and the direct vision call in `vision/client.ts`, which never
 * goes through TrueForge at all. They are tuned separately because they fail
 * differently - a thinner operator replans worse, while a thinner vision call
 * mostly just answers sooner, and the vision model bills its reasoning against
 * the same token ceiling as its answer, so effort there is a truncation risk.
 *
 * The operator defaults to `high` so navigation and recovery decisions receive
 * deliberate reasoning. The direct vision primitive stays at `low`: it has a
 * narrow grounding job and bills reasoning against the same token ceiling as
 * its JSON answer, so increasing it creates a truncation risk.
 *
 * The provider validates this value upstream (`unknown variant` for anything
 * outside the enum), so an unchecked string here would surface as an opaque
 * 400 mid-run; it is parsed at the edge instead.
 */

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_AGENT_REASONING_EFFORT: ReasoningEffort = "high";
export const DEFAULT_VISION_REASONING_EFFORT: ReasoningEffort = "low";

export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : null;
}

export interface ReasoningSettings {
  /** Effort on the operator agent's manifest; applies to every later turn. */
  agent: ReasoningEffort;
  /** Effort on the direct vision call behind `inspect_screen_visually`. */
  vision: ReasoningEffort;
}

/**
 * Env overrides are read once at import: they are the boot default, and the
 * API is the way to change it afterwards, so re-reading would silently undo
 * a live change.
 */
const settings: ReasoningSettings = {
  agent: fromEnv("REASONING_EFFORT", DEFAULT_AGENT_REASONING_EFFORT),
  vision: fromEnv("VISION_REASONING_EFFORT", DEFAULT_VISION_REASONING_EFFORT),
};

function fromEnv(name: string, fallback: ReasoningEffort): ReasoningEffort {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseReasoningEffort(raw);
  if (!parsed) {
    throw new Error(
      `${name}=${raw} is not a reasoning effort. Use one of ${REASONING_EFFORTS.join(", ")}.`,
    );
  }
  return parsed;
}

export function reasoningSettings(): ReasoningSettings {
  return { ...settings };
}

export function agentReasoningEffort(): ReasoningEffort {
  return settings.agent;
}

export function visionReasoningEffort(): ReasoningEffort {
  return settings.vision;
}

/**
 * Records a new level. Returns the fields that actually changed, because the
 * agent field costs a manifest round trip to apply and the caller should skip
 * that when nothing moved.
 */
export function updateReasoningSettings(
  patch: Partial<ReasoningSettings>,
): { settings: ReasoningSettings; changed: Array<keyof ReasoningSettings> } {
  const changed: Array<keyof ReasoningSettings> = [];
  for (const key of ["agent", "vision"] as const) {
    const next = patch[key];
    if (next && next !== settings[key]) {
      settings[key] = next;
      changed.push(key);
    }
  }
  return { settings: reasoningSettings(), changed };
}
