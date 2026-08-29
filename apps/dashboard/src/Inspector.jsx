import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, CircleNotch, DeviceMobile, Images } from "@phosphor-icons/react";
import { API, getJson, setReasoning } from "./api.js";
import { FrameLightbox, FrameThumb } from "./Transcript.jsx";
import {
  formatBytes,
  formatCost,
  formatDuration,
  formatMs,
  formatTime,
  formatTokens,
} from "./format.js";

const TABS = ["Device", "Frames", "Metrics", "Agent", "Logs"];

function StatusDot({ ok = true }) {
  return <span className={`status-dot ${ok ? "ok" : "bad"}`} />;
}

function Facts({ rows }) {
  return (
    <dl className="inspector-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function DeviceTab({ status, device, state, screenshot, onRefresh }) {
  const data = state?.result || state || {};
  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-title">
          <span>Device state</span>
          <button className="icon-button" onClick={onRefresh} aria-label="Refresh inspector">
            <ArrowsClockwise />
          </button>
        </div>
        <div className="health-line">
          <span><StatusDot ok={Boolean(device)} /> {device ? "Live" : "Offline"}</span>
          <time>{formatTime(status?.serverTime)}</time>
        </div>
        <Facts rows={[
          ["Foreground", data.foregroundPackage || data.packageName],
          ["Orientation", data.orientation],
          ["Accessibility", device?.accessibilityServiceEnabled ? "Active" : "Unavailable"],
          ["Last snapshot", data.lastSnapshotId],
          ["Battery", data.batteryPercent !== undefined ? `${data.batteryPercent}%` : null],
          ["Screen", data.screenInteractive === undefined ? null : data.screenInteractive ? "On" : "Off"],
        ]} />
      </section>
      <section className="inspector-section screen-section">
        <div className="inspector-title">
          <span>Screen snapshot</span>
          <time>{formatTime(status?.serverTime)}</time>
        </div>
        <div className="screen-preview">
          {screenshot
            ? <img src={screenshot} alt="Current tablet screen" />
            : <div className="screen-placeholder"><DeviceMobile /><span>Snapshot unavailable</span></div>}
        </div>
      </section>
      <section className="inspector-section">
        <div className="inspector-title">
          <span>Bridge / MCP</span>
          <span className="healthy"><StatusDot /> Connected</span>
        </div>
        <Facts rows={[
          ["Device gateway", "Port 8792"],
          ["MCP server", "Port 8791"],
          ["Runtime", "Port 8790"],
          ["Transport", "WebSocket"],
        ]} />
      </section>
    </div>
  );
}

/**
 * Every screen the agent captured during this run, in order.
 *
 * The transcript answers "what did this step look at"; this answers "what did
 * the run see", which is the view that makes a visual recovery reviewable —
 * especially a sub-agent's, whose frames are collapsed inside its container by
 * default. Frames live in a bounded in-memory store, so an older run shows the
 * expired placeholder rather than an image.
 */
function FramesTab({ items, running }) {
  const [frame, setFrame] = useState(null);
  const frames = useMemo(
    () => items
      .filter((item) => item.tool?.frame)
      .map((item) => ({
        key: item.id,
        frame: item.tool.frame,
        tool: item.tool.name,
        at: item.at,
        threadId: item.threadId,
      })),
    [items],
  );

  const threads = useMemo(() => {
    const names = new Map();
    for (const item of items) {
      if (item.kind === "subagent" && item.subAgent) {
        names.set(item.subAgent.threadId, item.subAgent.name);
      }
    }
    return names;
  }, [items]);

  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-title">
          <span>Frames</span>
          <span>{frames.length}{running && <CircleNotch className="spin" />}</span>
        </div>
        {!frames.length && (
          <div className="frames-empty">
            <Images />
            <span>No screen was captured in this run.</span>
          </div>
        )}
        <div className="frame-strip">
          {frames.map((entry) => (
            <div key={entry.key} className="frame-strip-item">
              <FrameThumb
                frame={entry.frame}
                onOpen={setFrame}
                caption={formatTime(entry.at)}
              />
              <span className="frame-strip-label">
                {entry.tool}
                {threads.has(entry.threadId) ? ` \u00b7 ${threads.get(entry.threadId)}` : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
      {frame && <FrameLightbox frame={frame} onClose={() => setFrame(null)} />}
    </div>
  );
}

/**
 * Token, cost and latency accounting.
 *
 * TrueForge reports per-turn `metrics` on `turn.done` and a per-call
 * `inputTokensBreakdown`; both are what make a slow or expensive run
 * explainable rather than just "it took a while".
 */
function MetricsTab({ run, items, running, analytics }) {
  const stats = useMemo(() => {
    const tools = items.filter((item) => item.kind === "tool");
    const durations = tools
      .map((item) => item.tool?.durationMs)
      .filter((value) => typeof value === "number");
    const byTool = new Map();
    for (const item of tools) {
      const name = item.tool?.name || "unknown";
      const entry = byTool.get(name) || { name, count: 0, errors: 0, totalMs: 0 };
      entry.count += 1;
      if (item.status === "error") entry.errors += 1;
      entry.totalMs += item.tool?.durationMs || 0;
      byTool.set(name, entry);
    }
    return {
      toolCalls: tools.length,
      toolErrors: tools.filter((item) => item.status === "error").length,
      approvals: items.filter((item) => item.kind === "approval").length,
      denied: items.filter((item) => item.approval?.decision === "deny").length,
      thinking: items.filter((item) => item.kind === "reasoning").length,
      resultBytes: tools.reduce((total, item) => total + (item.tool?.resultBytes || 0), 0),
      slowest: durations.length ? Math.max(...durations) : null,
      turns: items.filter((item) => item.kind === "turn"),
      byTool: [...byTool.values()].sort((a, b) => b.count - a.count),
    };
  }, [items]);

  const metrics = run?.metrics
    || stats.turns.reduce((total, item) => {
      const turnMetrics = item.turnDetail?.metrics;
      if (!turnMetrics) return total;
      if (!total) return { ...turnMetrics };
      return {
        inputTokens: total.inputTokens + turnMetrics.inputTokens,
        outputTokens: total.outputTokens + turnMetrics.outputTokens,
        totalTokens: total.totalTokens + turnMetrics.totalTokens,
        cacheReadTokens: total.cacheReadTokens + turnMetrics.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + turnMetrics.cacheWriteTokens,
        reasoningTokens: total.reasoningTokens + turnMetrics.reasoningTokens,
        costUsd: total.costUsd === null && turnMetrics.costUsd === null
          ? null
          : (total.costUsd || 0) + (turnMetrics.costUsd || 0),
      };
    }, null);

  const cacheRate = metrics && metrics.inputTokens
    ? Math.round((metrics.cacheReadTokens / metrics.inputTokens) * 100)
    : null;

  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-title"><span>This run</span>{running && <CircleNotch className="spin" />}</div>
        <div className="metric-grid">
          <div><span>{formatTokens(metrics?.totalTokens)}</span><label>Total tokens</label></div>
          <div><span>{formatCost(metrics?.costUsd)}</span><label>Est. cost</label></div>
          <div><span>{run ? formatDuration(run.startedAt, run.finishedAt) : "—"}</span><label>Duration</label></div>
          <div><span>{stats.toolCalls}</span><label>Tool calls</label></div>
        </div>
        <Facts rows={[
          ["Input tokens", formatTokens(metrics?.inputTokens)],
          ["Output tokens", formatTokens(metrics?.outputTokens)],
          ["Cache reads", metrics ? `${formatTokens(metrics.cacheReadTokens)}${cacheRate !== null ? ` (${cacheRate}%)` : ""}` : "—"],
          ["Reasoning tokens", formatTokens(metrics?.reasoningTokens)],
          ["Turns", run?.turnCount ?? stats.turns.length],
          ["Tool errors", stats.toolErrors],
          ["Approvals", `${stats.approvals}${stats.denied ? ` (${stats.denied} denied)` : ""}`],
          ["Tool payload", formatBytes(stats.resultBytes)],
          ["Slowest tool", formatMs(stats.slowest) ?? "—"],
        ]} />
      </section>

      {stats.byTool.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-title"><span>Tool usage</span><span>{stats.toolCalls}</span></div>
          <table className="mini-table">
            <thead><tr><th>Tool</th><th>n</th><th>avg</th><th>err</th></tr></thead>
            <tbody>
              {stats.byTool.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td>{entry.count}</td>
                  <td>{entry.count ? formatMs(Math.round(entry.totalMs / entry.count)) : "—"}</td>
                  <td className={entry.errors ? "danger-text" : ""}>{entry.errors || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {stats.turns.length > 0 && (
        <section className="inspector-section">
          <div className="inspector-title"><span>Per turn</span></div>
          <table className="mini-table">
            <thead><tr><th>#</th><th>tokens</th><th>cost</th><th>state</th></tr></thead>
            <tbody>
              {stats.turns.map((item, index) => (
                <tr key={item.id}>
                  <td>{item.turnDetail?.index ?? index + 1}</td>
                  <td>{formatTokens(item.turnDetail?.metrics?.totalTokens)}</td>
                  <td>{formatCost(item.turnDetail?.metrics?.costUsd)}</td>
                  <td>{item.turnDetail?.status ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {analytics && (
        <section className="inspector-section">
          <div className="inspector-title"><span>All runs (this server)</span></div>
          <Facts rows={[
            ["Runs", analytics.runs],
            ["Completed", analytics.completed],
            ["Failed", analytics.failed],
            ["Prompts", analytics.turns],
            ["Median duration", analytics.medianDurationMs !== null ? formatMs(analytics.medianDurationMs) : "—"],
            ["Tokens", formatTokens(analytics.metrics?.totalTokens)],
            ["Cost", formatCost(analytics.metrics?.costUsd)],
          ]} />
        </section>
      )}
    </div>
  );
}

/**
 * Reasoning effort, live.
 *
 * Two levels, because two different callers spend reasoning tokens: the
 * operator agent (a manifest field, so it lands on the next turn rather than
 * the running one) and the direct vision call, which is read per request and
 * changes immediately. The distinction is stated in the UI because "I changed
 * it and nothing happened" is otherwise the obvious first impression.
 */
function ReasoningControls({ reasoning, onChange }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const options = reasoning?.options || [];

  const apply = async (key, value) => {
    setPending(key);
    setError(null);
    try {
      onChange(await setReasoning({ [key]: value }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="inspector-section">
      <div className="inspector-title">
        <span>Reasoning effort</span>
        {pending && <CircleNotch className="spin" />}
      </div>
      <div className="reasoning-controls">
        {[
          ["agent", "Operator", "Applies from the next turn."],
          ["vision", "Vision call", "Applies to the next look."],
        ].map(([key, label, note]) => (
          <label key={key} className="reasoning-row">
            <span className="reasoning-row-label">{label}</span>
            <select
              value={reasoning?.[key] || "low"}
              disabled={!reasoning || pending !== null}
              onChange={(event) => apply(key, event.target.value)}
            >
              {options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <span className="reasoning-note">{note}</span>
          </label>
        ))}
      </div>
      {error && <div className="logs-note error">{error}</div>}
    </section>
  );
}

/** What the model was actually told: model, gates, and the operating policy. */
function AgentTab({ agent, status, reasoning, onReasoningChange }) {
  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-title"><span>Agent</span><span className="accent-text">{agent?.name || status?.agent || "—"}</span></div>
        <Facts rows={[
          ["Model", agent?.model || status?.model],
          ["Vision model", agent?.visionModel],
          ["MCP server", agent?.mcpServer],
          ["Code Mode sandbox", agent ? (agent.sandbox ? "Enabled" : "Disabled") : null],
          ["Iteration limit", agent?.iterationLimit],
          ["Approval-gated", agent?.gatedTools?.join(", ")],
        ]} />
      </section>
      <ReasoningControls reasoning={reasoning} onChange={onReasoningChange} />
      <section className="inspector-section">
        <div className="inspector-title"><span>System prompt</span><span>{agent?.instructions?.length ?? 0} chars</span></div>
        <pre className="policy-text">{agent?.instructions || "Loading…"}</pre>
      </section>
    </div>
  );
}

/**
 * Raw TrueForge events.
 *
 * Delta events are hidden by default: a single turn emits hundreds of
 * few-character fragments that drown every event worth reading, and the
 * transcript already shows their merged result.
 */
function LogsTab({ runId }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showDeltas, setShowDeltas] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson(`/dashboard/runs/${encodeURIComponent(runId)}/events`)
      .then((body) => {
        if (cancelled) return;
        setEvents((body.events || []).map((entry) => entry?.event || entry));
      })
      .catch((cause) => !cancelled && setError(cause.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [runId]);

  const types = useMemo(() => {
    const seen = new Map();
    for (const event of events) {
      seen.set(event?.type, (seen.get(event?.type) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);

  const visible = useMemo(() => events.filter((event) => {
    if (!showDeltas && event?.type === "model.message.delta") return false;
    return typeFilter === "all" || event?.type === typeFilter;
  }), [events, showDeltas, typeFilter]);

  return (
    <div className="logs-pane">
      <div className="logs-controls">
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
          <option value="all">All types ({events.length})</option>
          {types.map(([type, count]) => (
            <option key={type} value={type}>{type} ({count})</option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={showDeltas} onChange={(event) => setShowDeltas(event.target.checked)} />
          Deltas
        </label>
        <a className="raw-link" href={`${API}/dashboard/runs/${encodeURIComponent(runId || "")}/events`} target="_blank" rel="noreferrer">JSON</a>
      </div>
      {loading && <div className="logs-note"><CircleNotch className="spin" /> Loading events…</div>}
      {error && <div className="logs-note error">{error}</div>}
      {!loading && !error && !visible.length && <div className="logs-note">No events to show.</div>}
      <div className="logs-list">
        {visible.map((event, index) => (
          <details key={event?.id ? `${event.id}-${index}` : index} className="log-entry">
            <summary>
              <span className={`log-type ${String(event?.type || "").split(".")[0]}`}>{event?.type}</span>
              <time>{formatTime(event?.createdAt || event?.created_at)}</time>
            </summary>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

export function Inspector({
  status,
  device,
  state,
  screenshot,
  run,
  items,
  running,
  agent,
  analytics,
  reasoning,
  onReasoningChange,
  onRefresh,
  mobileActive,
}) {
  const [tab, setTab] = useState("Device");
  return (
    <aside className={`inspector ${mobileActive ? "mobile-active" : ""}`}>
      <div className="inspector-tabs">
        {TABS.map((entry) => (
          <button key={entry} className={tab === entry ? "active" : ""} onClick={() => setTab(entry)}>
            {entry}
          </button>
        ))}
      </div>
      {tab === "Device" && (
        <DeviceTab status={status} device={device} state={state} screenshot={screenshot} onRefresh={onRefresh} />
      )}
      {tab === "Frames" && <FramesTab items={items} running={running} />}
      {tab === "Metrics" && (
        <MetricsTab run={run} items={items} running={running} analytics={analytics} />
      )}
      {tab === "Agent" && (
        <AgentTab
          agent={agent}
          status={status}
          reasoning={reasoning}
          onReasoningChange={onReasoningChange}
        />
      )}
      {tab === "Logs" && <LogsTab runId={run?.id} />}
    </aside>
  );
}
