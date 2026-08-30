export const API = "/api";

/** Reads an NDJSON body line by line, tolerating a trailing partial line. */
export async function* readNdjson(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // A malformed line is a transport hiccup, not a reason to drop the run.
        }
      }
      if (done) return;
    }
  } finally {
    if (signal?.aborted) reader.cancel().catch(() => {});
  }
}

export async function getJson(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export function startRun({ prompt, runId, deviceId }, signal) {
  return fetch(`${API}/dashboard/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(runId ? { prompt, runId, deviceId } : { prompt, deviceId }),
    signal,
  });
}

export function cancelRun(runId) {
  return fetch(`${API}/dashboard/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export function openTranscript(runId, signal) {
  return fetch(`${API}/dashboard/runs/${encodeURIComponent(runId)}/transcript`, { signal });
}

/**
 * URL for a captured screen frame.
 *
 * The transcript carries only the id: the bytes are served as an ordinary
 * image so the browser caches and decodes them, instead of a base64 blob
 * riding along in every transcript payload. The store is in-memory and
 * bounded, so this can 404 for an old run — callers render a placeholder.
 */
export const frameUrl = (frameId) => `${API}/frames/${encodeURIComponent(frameId)}`;

export function getReasoning() {
  return getJson("/dashboard/reasoning");
}

/** Sets one or both reasoning levels; `{ agent }`, `{ vision }`, or both. */
export function setReasoning(patch) {
  return getJson("/dashboard/reasoning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}
