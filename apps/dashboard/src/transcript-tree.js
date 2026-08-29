/**
 * Transcript grouping.
 *
 * Kept out of the component so it can be tested directly: the nesting is the
 * part with real logic in it, and a wrong parent makes a sub-agent's device
 * traffic look like the main thread's.
 */

export const FILTERS = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools", kinds: ["tool"] },
  { id: "thinking", label: "Thinking", kinds: ["reasoning", "assistant"] },
  { id: "problems", label: "Problems" },
];

function matchesFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "problems") return item.status === "error" || item.status === "warning";
  const config = FILTERS.find((entry) => entry.id === filter);
  return config?.kinds ? config.kinds.includes(item.kind) : true;
}

/**
 * Nests each sub-agent's items under the container that spawned them.
 *
 * The server already stamps every item with the thread it happened on and
 * emits one `subagent` item per delegation, so this is purely a regrouping:
 * items whose thread has a container become that container's children, and
 * everything else stays on the main line, ordered by `seq` as before. A
 * container itself sits on its parent thread, which is what lets a sub-agent
 * spawned by a sub-agent nest correctly.
 */
export function groupByThread(items, filter) {
  const containers = new Map();
  for (const item of items) {
    if (item.kind === "subagent" && item.subAgent) {
      containers.set(item.subAgent.threadId, { ...item, nested: [] });
    }
  }

  const roots = [];
  // A thread with no container (an event stream that opened mid-run, or the
  // main thread itself) belongs on the main line rather than vanishing.
  const place = (item) => {
    const container = containers.get(item.threadId);
    if (container) container.nested.push(item);
    else roots.push(item);
  };

  for (const item of items) {
    if (item.kind === "subagent" && item.subAgent) {
      const self = containers.get(item.subAgent.threadId);
      const parent = containers.get(item.subAgent.parentThreadId);
      if (parent && parent !== self) parent.nested.push(self);
      else roots.push(self);
      continue;
    }
    if (!matchesFilter(item, filter)) continue;
    place(item);
  }

  const bySeq = (a, b) => a.seq - b.seq;
  for (const container of containers.values()) container.nested.sort(bySeq);
  // A container survives a filter only when it still has something to show,
  // so "Problems" does not leave a wall of empty sub-agent rows behind.
  const keep = (item) => item.kind !== "subagent"
    || filter === "all"
    || item.nested.length > 0
    || matchesFilter(item, filter);
  return roots.filter(keep).sort(bySeq);
}
