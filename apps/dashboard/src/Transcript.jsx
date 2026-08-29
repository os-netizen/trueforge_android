import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  CaretRight,
  Check,
  CircleNotch,
  Copy,
  ImageBroken,
  Lock,
  Robot,
  Terminal,
  TreeStructure,
  User,
  Warning,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { frameUrl } from "./api.js";
import { FILTERS, groupByThread } from "./transcript-tree.js";
import {
  formatBytes,
  formatCost,
  formatMs,
  formatTime,
  formatTokens,
  prettyJson,
  summarizeArgs,
  summarizeResult,
} from "./format.js";

function StatusIcon({ status }) {
  if (status === "running") return <CircleNotch className="spin" />;
  if (status === "error") return <XCircle weight="fill" />;
  if (status === "warning") return <Warning weight="fill" />;
  return <Check weight="bold" />;
}

function CopyButton({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      <Copy /> {copied ? "Copied" : label}
    </button>
  );
}

/**
 * A captured screen, as a thumbnail on the tool card.
 *
 * The image is fetched by id rather than carried in the transcript, so this is
 * an ordinary <img> the browser caches. Frames live in a bounded in-memory
 * store, so an old run's frame is genuinely gone — that is a placeholder, not
 * an error, and it is labelled as such rather than showing a broken image.
 */
export function FrameThumb({ frame, onOpen, caption }) {
  const [failed, setFailed] = useState(false);
  const scale = frame.width ? frame.sourceWidth / frame.width : 1;

  if (failed) {
    return (
      <div className="frame-thumb expired" title="Frames are held in memory only and are dropped when the run ages out">
        <ImageBroken />
        <span>Frame expired</span>
      </div>
    );
  }

  return (
    <button type="button" className="frame-thumb" onClick={() => onOpen(frame)}>
      <img src={frameUrl(frame.id)} alt="Captured device screen" onError={() => setFailed(true)} loading="lazy" />
      <span className="frame-meta">
        {caption || `${frame.width}\u00d7${frame.height}`}
        {scale && Math.abs(scale - 1) > 0.01 ? ` \u00b7 \u00d7${scale.toFixed(2)}` : ""}
      </span>
    </button>
  );
}

/**
 * Full-size viewer.
 *
 * Clicking the image reports the point in *native screen* pixels, not image
 * pixels: that is the space tap_coordinates works in, and converting by hand
 * from a downsampled frame is exactly the error the vision path exists to
 * avoid.
 */
export function FrameLightbox({ frame, onClose }) {
  const [point, setPoint] = useState(null);

  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const readPoint = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratioX = (event.clientX - box.left) / box.width;
    const ratioY = (event.clientY - box.top) / box.height;
    setPoint({
      x: Math.round(ratioX * (frame.sourceWidth || frame.width)),
      y: Math.round(ratioY * (frame.sourceHeight || frame.height)),
    });
  };

  return (
    <div className="frame-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="frame-lightbox-inner" onClick={(event) => event.stopPropagation()}>
        <div className="frame-lightbox-head">
          <span>
            {frame.width}&times;{frame.height} shown &middot; {frame.sourceWidth}&times;{frame.sourceHeight} on device
          </span>
          {point && (
            <span className="frame-point">
              tap_coordinates {point.x}, {point.y}
              <CopyButton value={`${point.x}, ${point.y}`} label="Copy point" />
            </span>
          )}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <img src={frameUrl(frame.id)} alt="Captured device screen" onClick={readPoint} />
        <div className="frame-lightbox-foot">Click the image to read a point in device pixels.</div>
      </div>
    </div>
  );
}

/**
 * One tool call, collapsed to a single line until it is opened.
 *
 * The header answers "what did the agent do" — tool, key arguments, outcome,
 * latency — and the body carries the exact JSON that went out and came back,
 * which is what diagnosing a wrong action actually needs.
 */
function ToolCard({ item, expandAll, onOpenFrame }) {
  const [open, setOpen] = useState(false);
  const expanded = open || expandAll;
  const tool = item.tool;
  const args = useMemo(() => prettyJson(tool.args), [tool.args]);
  const result = useMemo(() => prettyJson(tool.result || ""), [tool.result]);
  const duration = formatMs(tool.durationMs);

  return (
    <div className={`tool-card ${item.status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)}>
        <CaretRight className={`caret ${expanded ? "open" : ""}`} />
        <Terminal className="tool-glyph" weight="bold" />
        <span className="tool-name">{tool.name}</span>
        {tool.gated && <span className="tool-badge gated"><Lock weight="fill" /> gated</span>}
        {tool.server && <span className="tool-badge">{tool.server}</span>}
        <span className="tool-args-gist">{summarizeArgs(tool.args)}</span>
        <span className="tool-spacer" />
        {duration && <span className="tool-duration">{duration}</span>}
        <span className={`tool-status ${item.status}`}><StatusIcon status={item.status} /></span>
      </button>
      {tool.frame && (
        <div className="tool-frame">
          <FrameThumb frame={tool.frame} onOpen={onOpenFrame} />
        </div>
      )}
      {!expanded && tool.result && (
        <div className="tool-result-gist">{summarizeResult(tool.result)}</div>
      )}
      {expanded && (
        <div className="tool-body">
          <div className="tool-pane">
            <div className="tool-pane-head">
              <span>Arguments{tool.argsPartial ? " (streaming)" : ""}</span>
              <CopyButton value={args} />
            </div>
            <pre>{args || "{}"}</pre>
          </div>
          <div className="tool-pane">
            <div className="tool-pane-head">
              <span>
                Result{tool.result ? ` · ${formatBytes(tool.resultBytes)}` : ""}
                {tool.resultTruncated ? " · truncated" : ""}
              </span>
              {tool.result && <CopyButton value={result} />}
            </div>
            <pre className={item.status === "error" ? "error" : ""}>
              {tool.result ? result : item.status === "running" ? "Waiting for the device…" : "No result"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Model reasoning, collapsed by default so it never buries the actions. */
function ReasoningCard({ item, expandAll }) {
  const [open, setOpen] = useState(false);
  const expanded = open || expandAll;
  const text = item.text || "";
  const preview = text.replace(/\s+/g, " ").trim();
  return (
    <div className="reasoning-card">
      <button type="button" className="reasoning-head" onClick={() => setOpen((value) => !value)}>
        <CaretRight className={`caret ${expanded ? "open" : ""}`} />
        <Brain weight="duotone" />
        <span className="reasoning-label">Thinking</span>
        {item.status === "running" && <CircleNotch className="spin" />}
        {!expanded && <span className="reasoning-preview">{preview.slice(0, 130)}</span>}
        <span className="tool-spacer" />
        <span className="reasoning-size">{preview.length} chars</span>
      </button>
      {expanded && <pre className="reasoning-body">{text}</pre>}
    </div>
  );
}

function TurnDivider({ item }) {
  const metrics = item.turnDetail?.metrics;
  return (
    <div className={`turn-divider ${item.status}`}>
      <span className="turn-divider-label">{item.title}</span>
      {metrics && (
        <span className="turn-divider-metrics">
          {formatTokens(metrics.inputTokens)} in · {formatTokens(metrics.outputTokens)} out
          {metrics.cacheReadTokens ? ` · ${formatTokens(metrics.cacheReadTokens)} cached` : ""}
          {metrics.costUsd !== null ? ` · ${formatCost(metrics.costUsd)}` : ""}
        </span>
      )}
      {item.text && <span className="turn-divider-error">{item.text}</span>}
      <time>{formatTime(item.at)}</time>
    </div>
  );
}

/**
 * A delegated sub-agent, rendered as a container around its own work.
 *
 * Collapsed it answers the only question the main thread cares about — what
 * did the delegation cost and what did it report back. Opened, its thinking,
 * its tool calls and the frames it captured render inside, in order, so a
 * vision recovery reads as one step of the parent run rather than a stretch of
 * unattributed device traffic spliced into it.
 */
function SubAgentCard({ item, nested, expandAll, onOpenFrame }) {
  const [open, setOpen] = useState(false);
  const expanded = open || expandAll;
  const detail = item.subAgent || {};
  const tools = nested.filter((child) => child.kind === "tool");
  const frames = tools.filter((child) => child.tool?.frame).length;
  const elapsed = detail.finishedAt && detail.startedAt
    ? formatMs(Date.parse(detail.finishedAt) - Date.parse(detail.startedAt))
    : null;

  return (
    <div className={`subagent-card ${item.status}`}>
      <button type="button" className="subagent-head" onClick={() => setOpen((value) => !value)}>
        <CaretRight className={`caret ${expanded ? "open" : ""}`} />
        <TreeStructure weight="bold" className="subagent-glyph" />
        <span className="subagent-name">{detail.name || item.title}</span>
        <span className="tool-badge">sub-agent</span>
        <span className="subagent-gist">{(detail.input || "").replace(/\s+/g, " ").slice(0, 90)}</span>
        <span className="tool-spacer" />
        <span className="subagent-counts">
          {tools.length} tool{tools.length === 1 ? "" : "s"}
          {frames ? ` \u00b7 ${frames} frame${frames === 1 ? "" : "s"}` : ""}
        </span>
        {elapsed && <span className="tool-duration">{elapsed}</span>}
        <span className={`tool-status ${item.status}`}><StatusIcon status={item.status} /></span>
      </button>
      {expanded && (
        <div className="subagent-body">
          {detail.input && (
            <div className="subagent-brief">
              <span>Brief</span>
              <p>{detail.input}</p>
            </div>
          )}
          {nested.map((child) => (
            <TranscriptRow key={child.id} item={child} expandAll={expandAll} onOpenFrame={onOpenFrame} />
          ))}
          {!nested.length && (
            <div className="subagent-empty">
              {item.status === "running" ? "Working…" : "No activity recorded on this thread."}
            </div>
          )}
        </div>
      )}
      {detail.output && (
        <div className="subagent-report">
          <strong>Reported back</strong>
          <p>{detail.output}</p>
        </div>
      )}
    </div>
  );
}

function TranscriptRow({ item, expandAll, onOpenFrame }) {
  if (item.kind === "turn") return <TurnDivider item={item} />;
  if (item.kind === "subagent") {
    return (
      <SubAgentCard item={item} nested={item.nested || []} expandAll={expandAll} onOpenFrame={onOpenFrame} />
    );
  }
  if (item.kind === "tool") return <ToolCard item={item} expandAll={expandAll} onOpenFrame={onOpenFrame} />;
  if (item.kind === "reasoning") return <ReasoningCard item={item} expandAll={expandAll} />;

  if (item.kind === "user") {
    return (
      <div className="message-row user">
        <span className="message-avatar"><User weight="fill" /></span>
        <div className="message-body">
          <div className="message-head"><strong>You</strong><time>{formatTime(item.at)}</time></div>
          <p>{item.text}</p>
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="message-row assistant">
        <span className="message-avatar"><Robot weight="fill" /></span>
        <div className="message-body">
          <div className="message-head"><strong>Agent</strong><time>{formatTime(item.at)}</time></div>
          <p className="assistant-text">{item.text}</p>
        </div>
      </div>
    );
  }

  if (item.kind === "approval") {
    return (
      <div className={`approval-row ${item.status}`}>
        <span className="approval-icon"><Lock weight="fill" /></span>
        <div>
          <strong>{item.title}</strong>
          <p>{item.approval?.intent}</p>
          {item.approval?.reason && <p className="approval-reason">{item.approval.reason}</p>}
        </div>
        <time>{formatTime(item.at)}</time>
      </div>
    );
  }

  return (
    <div className={`system-row ${item.status}`}>
      <StatusIcon status={item.status} />
      <strong>{item.title}</strong>
      {item.text && <span>{item.text}</span>}
      <time>{formatTime(item.at)}</time>
    </div>
  );
}



export function Transcript({ items, running, emptyHint }) {
  const [filter, setFilter] = useState("all");
  const [expandAll, setExpandAll] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);

  const [frame, setFrame] = useState(null);

  const visible = useMemo(() => groupByThread(items, filter), [items, filter]);

  const counts = useMemo(() => ({
    tools: items.filter((item) => item.kind === "tool").length,
    frames: items.filter((item) => item.tool?.frame).length,
    problems: items.filter((item) => item.status === "error" || item.status === "warning").length,
  }), [items]);

  // Following the tail is only helpful while the operator has not scrolled up
  // to read something; a jump-back-to-live control beats fighting the scroll.
  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    setFollow(atBottom);
  }, []);

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [visible, follow]);

  return (
    <section className="transcript">
      <div className="transcript-toolbar">
        <div className="filter-group">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={filter === entry.id ? "active" : ""}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
              {entry.id === "tools" && counts.tools > 0 && <span className="pill">{counts.tools}</span>}
              {entry.id === "problems" && counts.problems > 0 && (
                <span className="pill danger">{counts.problems}</span>
              )}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={expandAll}
            onChange={(event) => setExpandAll(event.target.checked)}
          />
          Expand tool I/O
        </label>
      </div>

      <div className="transcript-scroll" ref={scrollRef} onScroll={onScroll}>
        {!visible.length && (
          <div className="empty-state">
            <Robot weight="duotone" />
            <h2>{items.length ? "Nothing matches this filter" : "No activity yet"}</h2>
            <p>{items.length ? "Switch back to All to see the whole run." : emptyHint}</p>
          </div>
        )}
        {visible.map((item) => (
          <TranscriptRow key={item.id} item={item} expandAll={expandAll} onOpenFrame={setFrame} />
        ))}
        {running && (
          <div className="streaming-row"><CircleNotch className="spin" /> Agent is working…</div>
        )}
        <div ref={bottomRef} />
      </div>

      {!follow && running && (
        <button type="button" className="follow-button" onClick={() => setFollow(true)}>
          Jump to live
        </button>
      )}

      {frame && <FrameLightbox frame={frame} onClose={() => setFrame(null)} />}
    </section>
  );
}
