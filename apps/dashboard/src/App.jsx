import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  Brain,
  Check,
  ChatCircleDots,
  CircleNotch,
  ClockCounterClockwise,
  DeviceMobile,
  GearSix,
  ListBullets,
  PaperPlaneTilt,
  PlugsConnected,
  Plus,
  Robot,
  Stop,
  TerminalWindow,
  XCircle,
} from "@phosphor-icons/react";
import { API, cancelRun, getJson, getReasoning, openTranscript, readNdjson, startRun } from "./api.js";
import { formatDuration, formatTime, formatTokens } from "./format.js";
import { Transcript } from "./Transcript.jsx";
import { Inspector } from "./Inspector.jsx";

function StatusDot({ ok = true }) {
  return <span className={`status-dot ${ok ? "ok" : "bad"}`} />;
}

/** Merges a streamed transcript item into an ordered list, in place of the old one. */
function mergeItem(items, item) {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    const next = [...items, item];
    next.sort((a, b) => a.seq - b.seq);
    return next;
  }
  const next = items.slice();
  next[index] = item;
  return next;
}

function AppNav({ mobilePanel, onMobilePanel }) {
  return (
    <nav className="app-nav" aria-label="Primary navigation">
      <div className="brand-mark"><Robot weight="duotone" /></div>
      <button className={`nav-button ${mobilePanel === "workspace" ? "active" : ""}`} aria-label="Workspace" onClick={() => onMobilePanel("workspace")}>
        <TerminalWindow weight="fill" /><span>Run</span>
      </button>
      <button className={`nav-button ${mobilePanel === "runs" ? "active" : ""}`} aria-label="Run history" onClick={() => onMobilePanel("runs")}>
        <ClockCounterClockwise /><span>History</span>
      </button>
      <button className={`nav-button ${mobilePanel === "inspector" ? "active" : ""}`} aria-label="Device inspector" onClick={() => onMobilePanel("inspector")}>
        <DeviceMobile /><span>Device</span>
      </button>
      <button className="nav-button desktop-only" aria-label="Tools"><PlugsConnected /></button>
      <button className="nav-button desktop-only" aria-label="Logs"><ListBullets /></button>
      <div className="nav-spacer" />
      <button className="nav-button desktop-only" aria-label="Settings"><GearSix /></button>
      <div className="avatar">OM<span /></div>
    </nav>
  );
}

function RunsSidebar({ devices, device, onDeviceChange, runs, selectedId, onSelectRun, onNewRun, onRefresh, mobileActive }) {
  return (
    <aside className={`runs-sidebar ${mobileActive ? "mobile-active" : ""}`}>
      <div className="wordmark">TrueForge <strong>Control</strong></div>
      <section className="sidebar-section">
        <div className="eyebrow">Device</div>
        <div className="device-card">
          <div className="device-title-row">
            <div><StatusDot ok={Boolean(device)} /> <strong>{device?.model || "No device"}</strong></div>
            <button className="icon-button" onClick={onRefresh} aria-label="Refresh device"><ArrowsClockwise /></button>
          </div>
          <div className={`device-status ${device ? "online" : "offline"}`}>{device ? "Connected" : "Offline"}</div>
          {devices.length > 1 && (
            <label className="device-picker">
              <span>Operate on</span>
              <select value={device?.deviceId || ""} onChange={(event) => onDeviceChange(event.target.value)}>
                {devices.map((entry) => (
                  <option key={entry.deviceId} value={entry.deviceId}>{entry.model || entry.deviceId}</option>
                ))}
              </select>
            </label>
          )}
          <dl className="device-facts">
            <div><dt>System</dt><dd>{device ? `Android ${device.androidVersion}` : "—"}</dd></div>
            <div><dt>Accessibility</dt><dd>{device?.accessibilityServiceEnabled ? "Active" : "Unavailable"}</dd></div>
            <div><dt>Device ID</dt><dd>{device?.deviceId || "—"}</dd></div>
          </dl>
        </div>
      </section>
      <section className="sidebar-section runs-section">
        <div className="section-heading">
          <span className="eyebrow">Sessions</span>
          <button className="new-run-button" onClick={onNewRun}><Plus weight="bold" /> New</button>
        </div>
        <div className="run-list">
          {!runs.length && (
            <div className="empty-runs"><ClockCounterClockwise /><p>Your recent agent sessions will appear here.</p></div>
          )}
          {runs.map((run) => (
            <button
              key={run.id}
              className={`run-item ${selectedId === run.id ? "selected" : ""}`}
              onClick={() => onSelectRun(run)}
            >
              <span className="run-time">
                {formatTime(run.startedAt)}
                {run.turnCount > 1 && <span className="run-turns">{run.turnCount} turns</span>}
              </span>
              <span className="run-prompt">{run.title || run.prompt}</span>
              <span className={`run-state ${run.status}`}>
                {(run.status === "running" || run.status === "starting") && <CircleNotch className="spin" />}
                {run.status === "completed" && <Check />}
                {run.status === "failed" && <XCircle />}
                {run.historical ? "history" : run.status}
                {run.metrics?.totalTokens ? <em>{formatTokens(run.metrics.totalTokens)} tok</em> : null}
              </span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

function PromptComposer({ onSubmit, running, disabled, continuing }) {
  const [prompt, setPrompt] = useState("");
  const submit = () => {
    if (prompt.trim() && !running && !disabled) {
      onSubmit(prompt.trim());
      setPrompt("");
    }
  };
  return (
    <div className="composer-wrap">
      <label htmlFor="agent-prompt">
        {continuing ? <><ChatCircleDots /> Continue this session</> : "New session"}
      </label>
      <div className="composer">
        <textarea
          id="agent-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={disabled
            ? "Connect a device to send a task"
            : continuing
              ? "Follow up — the agent keeps everything it just saw on the device…"
              : "Tell the agent what to do on the tablet…"}
          rows={3}
          disabled={disabled || running}
        />
        <div className="composer-footer">
          <span>Enter to send · Shift + Enter for a new line</span>
          <button className="send-button" onClick={submit} disabled={!prompt.trim() || running || disabled}>
            {running ? <CircleNotch className="spin" /> : <PaperPlaneTilt weight="fill" />}
            {running ? "Running" : continuing ? "Send follow-up" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [deviceState, setDeviceState] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [run, setRun] = useState(null);
  const [items, setItems] = useState([]);
  const [running, setRunning] = useState(false);
  const [agent, setAgent] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [reasoning, setReasoningState] = useState(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [mobilePanel, setMobilePanel] = useState("workspace");
  const transcriptAbort = useRef(null);

  const devices = status?.devices || [];
  const device = devices.find((entry) => entry.deviceId === selectedDeviceId) || devices[0] || null;

  useEffect(() => {
    if (device?.deviceId && device.deviceId !== selectedDeviceId) setSelectedDeviceId(device.deviceId);
  }, [device?.deviceId, selectedDeviceId]);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, runData] = await Promise.all([
        getJson("/dashboard/status"),
        getJson("/dashboard/runs"),
      ]);
      setStatus(nextStatus);
      setRuns(runData.runs || []);
      getJson("/dashboard/analytics").then(setAnalytics).catch(() => {});
      const nextDevice = nextStatus.devices?.find((entry) => entry.deviceId === selectedDeviceId)
        || nextStatus.devices?.[0];
      if (nextDevice) {
        const devicePath = `${API}/devices/${encodeURIComponent(nextDevice.deviceId)}`;
        void fetch(`${devicePath}/state`, { signal: AbortSignal.timeout(5000) })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => body && setDeviceState(body))
          .catch(() => {});
        void fetch(`${devicePath}/screenshot`, { signal: AbortSignal.timeout(7000) })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => {
            const result = body?.result || body;
            if (result?.dataBase64) setScreenshot(`data:image/png;base64,${result.dataBase64}`);
          })
          .catch(() => {});
      }
    } catch (error) {
      setStatus((current) => ({ ...(current || {}), ok: false, error: error.message }));
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    refresh();
    getJson("/dashboard/agent").then(setAgent).catch(() => {});
    getReasoning().then(setReasoningState).catch(() => {});
    const timer = window.setInterval(() => {
      getJson("/dashboard/status").then(setStatus).catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /**
   * Loads one run's transcript from the server.
   *
   * Both history and a run started elsewhere (the phone, another tab) come
   * through here, so selecting an old session shows that session — not
   * whatever the last live stream left in memory.
   */
  const loadRun = useCallback(async (runId) => {
    transcriptAbort.current?.abort();
    const controller = new AbortController();
    transcriptAbort.current = controller;
    setSelectedId(runId);
    setItems([]);
    setLoadingRun(true);
    try {
      const response = await openTranscript(runId, controller.signal);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      for await (const envelope of readNdjson(response, controller.signal)) {
        if (controller.signal.aborted) return;
        if (envelope.type === "run.snapshot") {
          setRun(envelope.data.run);
          setItems(envelope.data.items || []);
          setRunning(Boolean(envelope.data.live));
          setLoadingRun(false);
        } else if (envelope.type === "transcript.item") {
          setItems((current) => mergeItem(current, envelope.data));
        } else if (envelope.type.startsWith("run.")) {
          if (envelope.data?.id) setRun(envelope.data);
          if (envelope.type === "run.completed" || envelope.type === "run.failed") setRunning(false);
        } else if (envelope.type === "run.stream.end") {
          setRunning(false);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoadingRun(false);
    } finally {
      if (!controller.signal.aborted) setLoadingRun(false);
      refresh();
    }
  }, [refresh]);

  const submitPrompt = useCallback(async (prompt) => {
    // A follow-up continues the selected session; "New" clears the selection.
    // History-only sessions are not registered in this bridge process, so the
    // server cannot safely resume them even though their transcript is visible.
    const continuingId = run && !running && !run.historical ? run.id : undefined;
    transcriptAbort.current?.abort();
    const controller = new AbortController();
    transcriptAbort.current = controller;
    setRunning(true);
    if (!continuingId) setItems([]);

    const optimistic = {
      id: continuingId || `local-${Date.now()}`,
      deviceId: continuingId ? run.deviceId : device?.deviceId,
      prompt,
      title: continuingId ? run.title : prompt,
      status: "starting",
      startedAt: new Date().toISOString(),
      eventCount: 0,
      turnCount: continuingId ? (run.turnCount || 1) + 1 : 1,
    };
    setRun(optimistic);
    setSelectedId(optimistic.id);
    setRuns((current) => [optimistic, ...current.filter((entry) => entry.id !== optimistic.id)].slice(0, 20));

    try {
      const targetDeviceId = continuingId ? run.deviceId : device?.deviceId;
      const response = await startRun(
        { prompt, runId: continuingId, deviceId: targetDeviceId },
        controller.signal,
      );
      if (!response.ok || !response.body) {
        throw new Error((await response.json().catch(() => ({}))).error || "Could not start run");
      }
      for await (const envelope of readNdjson(response, controller.signal)) {
        if (transcriptAbort.current !== controller || controller.signal.aborted) return;
        if (envelope.type === "transcript.item") {
          setItems((current) => mergeItem(current, envelope.data));
        } else if (envelope.type.startsWith("run.")) {
          setRun(envelope.data);
          setSelectedId(envelope.data.id);
          setRuns((current) => [
            envelope.data,
            ...current.filter((entry) => entry.id !== envelope.data.id && !entry.id.startsWith("local-")),
          ].slice(0, 20));
        }
        // agent.event / approval.* are already folded into transcript items.
      }
    } catch (error) {
      if (controller.signal.aborted || transcriptAbort.current !== controller) return;
      setRun((current) => ({
        ...(current || optimistic),
        status: "failed",
        error: error.message,
        finishedAt: new Date().toISOString(),
      }));
      setItems((current) => mergeItem(current, {
        id: `client-error-${Date.now()}`,
        seq: Number.MAX_SAFE_INTEGER,
        kind: "system",
        turn: 1,
        threadId: "main",
        at: new Date().toISOString(),
        title: "Run failed",
        status: "error",
        text: error.message,
      }));
    } finally {
      if (transcriptAbort.current === controller) {
        setRunning(false);
        refresh();
      }
    }
  }, [run, running, refresh, device?.deviceId]);

  const stopRun = useCallback(() => {
    if (run?.id) cancelRun(run.id).catch(() => {});
  }, [run]);

  const newRun = useCallback(() => {
    transcriptAbort.current?.abort();
    setRun(null);
    setSelectedId(null);
    setItems([]);
    setRunning(false);
    setMobilePanel("workspace");
  }, []);

  const selectRun = useCallback((entry) => {
    if (entry.deviceId) setSelectedDeviceId(entry.deviceId);
    setMobilePanel("workspace");
    loadRun(entry.id);
  }, [loadRun]);

  const headline = useMemo(() => {
    if (!run) return "New agent session";
    const title = run.title || run.prompt || "";
    return title.length > 58 ? `${title.slice(0, 58)}…` : title;
  }, [run]);

  return (
    <div className="app-shell">
      <AppNav mobilePanel={mobilePanel} onMobilePanel={setMobilePanel} />
      <RunsSidebar
        devices={devices}
        device={device}
        onDeviceChange={setSelectedDeviceId}
        runs={runs}
        selectedId={selectedId}
        onSelectRun={selectRun}
        onNewRun={newRun}
        onRefresh={refresh}
        mobileActive={mobilePanel === "runs"}
      />
      <main className={`workspace ${mobilePanel === "workspace" ? "mobile-active" : ""}`}>
        <header className="run-header">
          <div>
            <div className="run-heading-line">
              <h1>{headline}</h1>
              <span className={`live-status ${running ? "running" : run?.status || "ready"}`}>
                {running && <CircleNotch className="spin" />}
                {running ? "In progress" : run?.status || "Ready"}
              </span>
              {reasoning && (
                <span className="reasoning-chip" title="Reasoning effort — change it in the Agent tab">
                  <Brain weight="duotone" /> {reasoning.agent}
                </span>
              )}
            </div>
            <p>
              {run
                ? `Started ${formatTime(run.startedAt)} · ${formatDuration(run.startedAt, run.finishedAt)} · ${run.turnCount || 1} turn${(run.turnCount || 1) === 1 ? "" : "s"}${run.sessionId ? ` · session ${run.sessionId.slice(0, 12)}` : ""}`
                : "Send an instruction to operate the connected tablet."}
            </p>
          </div>
          {running && (
            <button className="secondary-button danger" onClick={stopRun}><Stop weight="fill" /> Stop</button>
          )}
        </header>
        {loadingRun && <div className="loading-bar"><CircleNotch className="spin" /> Loading transcript…</div>}
        {run?.error && <div className="run-error-banner"><XCircle weight="fill" /> {run.error}</div>}
        <Transcript
          items={items}
          running={running}
          emptyHint="Prompts stream through TrueForge to the Android tool bridge. Every thought, tool call and device response lands here."
        />
        <PromptComposer
          onSubmit={submitPrompt}
          running={running}
          disabled={!device}
          continuing={Boolean(run && !running && !run.historical)}
        />
      </main>
      <Inspector
        status={status}
        device={device}
        state={deviceState}
        screenshot={screenshot}
        run={run}
        items={items}
        running={running}
        agent={agent}
        analytics={analytics}
        reasoning={reasoning}
        onReasoningChange={setReasoningState}
        onRefresh={refresh}
        mobileActive={mobilePanel === "inspector"}
      />
    </div>
  );
}
