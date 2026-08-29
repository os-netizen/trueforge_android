const timeFormat = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export const formatTime = (value) => (value ? timeFormat.format(new Date(value)) : "—");

export function formatDuration(start, end = Date.now()) {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function formatTokens(value) {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  return `${(value / 1000000).toFixed(2)}M`;
}

export function formatCost(usd) {
  if (usd === null || usd === undefined) return "—";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatBytes(count) {
  if (!count) return "0 B";
  if (count < 1024) return `${count} B`;
  return `${(count / 1024).toFixed(1)} KB`;
}

/** Pretty-prints a JSON string, leaving non-JSON (and partial deltas) alone. */
export function prettyJson(text) {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One-line gist of a tool's arguments for the collapsed card header. */
export function summarizeArgs(args) {
  if (!args) return "";
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args.replace(/\s+/g, " ").slice(0, 90);
  }
  if (!parsed || typeof parsed !== "object") return String(parsed).slice(0, 90);
  const entries = Object.entries(parsed)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => {
      const rendered = typeof value === "object"
        ? Array.isArray(value) ? `[${value.length}]` : "{…}"
        : String(value);
      return `${key}=${rendered.length > 34 ? `${rendered.slice(0, 34)}…` : rendered}`;
    });
  return entries.join("  ").slice(0, 120);
}

/** First meaningful line of a tool result, for the collapsed card header. */
export function summarizeResult(result) {
  if (!result) return "";
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === "object") {
      if (parsed.error) return `error: ${JSON.stringify(parsed.error).slice(0, 90)}`;
      return Object.entries(parsed)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${typeof value === "object" ? "…" : String(value).slice(0, 24)}`)
        .join("  ");
    }
  } catch {
    // Plain text result.
  }
  return result.replace(/\s+/g, " ").slice(0, 110);
}
