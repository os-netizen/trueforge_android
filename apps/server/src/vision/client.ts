import { config, OPENCODE_GO_BASE_URL, openCodeGoApiKey } from "../config.js";
import { visionReasoningEffort } from "../trueforge/reasoning.js";

/**
 * Direct client for the vision model.
 *
 * This is the cheap, deterministic visual primitive used by the short-lived
 * vision-recovery sub-agent: one HTTPS call at temperature 0 that answers one
 * question in strict JSON. The screenshot never enters either agent context;
 * only the compact JSON reaches the child, which summarizes it for the parent.
 * The operator policy still requires the child boundary for every pixel
 * question so the main agent has one consistent, auditable visual path.
 */

export interface VisionRequest {
  /** Base64 image bytes, without a data: prefix. */
  imageBase64: string;
  mimeType: string;
  /** Instruction and grounding data. Must ask for strict JSON. */
  prompt: string;
  timeoutMs?: number;
}

/** Injected in tests; production callers use {@link callVisionModel}. */
export type VisionCaller = (req: VisionRequest) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 45_000;

export async function callVisionModel(req: VisionRequest): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPENCODE_GO_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openCodeGoApiKey()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.visionModelId,
        // Generous because this model bills reasoning tokens against the same
        // budget, and a busy screen (a launcher full of icons) reasons for a
        // long time before answering. At 700 the JSON came back truncated; at
        // 2000 a home screen returned empty content having spent everything on
        // reasoning. The visible reply stays short either way - the prompt caps
        // the prose - so this ceiling is only ever reached by hidden reasoning.
        max_tokens: 4000,
        // This model bills reasoning against max_tokens, so effort here is not
        // only a cost dial: at a high effort a busy screen can spend the whole
        // ceiling thinking and come back with `finish_reason: "length"` and no
        // JSON at all. Low is the default for that reason as much as for cost.
        reasoning_effort: visionReasoningEffort(),
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: req.prompt },
              {
                type: "image_url",
                image_url: { url: `data:${req.mimeType};base64,${req.imageBase64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      // Never echo the body wholesale - it can repeat the request back at us.
      throw new Error(
        `Vision model ${config.visionModelId} returned ${response.status}: ` +
          `${(await response.text()).slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    // Checked before the empty-content case: running out of budget leaves
    // either half an object or nothing at all, and both would otherwise be
    // reported as something they are not.
    if (choice?.finish_reason === "length") {
      throw new Error(
        `Vision model ${config.visionModelId} hit its token limit before finishing its ` +
          "answer. Ask a narrower question about a smaller part of the screen.",
      );
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`Vision model ${config.visionModelId} returned no content`);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
