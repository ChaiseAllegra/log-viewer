import { ensureAuth, wireUserBox, sessionExpired } from "./auth.js";

interface FlowNode {
  event_type: string;
  events: number;
  jobs: number;
  first: string;
  last: string;
  breakdown_field: string | null;
  breakdown: { value: string; count: number }[];
}

interface FlowEdge {
  from: string;
  to: string;
  count: number;
}

interface FlowData {
  part_id: string;
  jobs: string[];
  funnel: { total_jobs: number; created: number; started: number; completed: number };
  nodes: FlowNode[];
  edges: FlowEdge[];
  job_paths: Record<string, string[]>;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const partSelect = $<HTMLSelectElement>("part-select");
const jobSelect = $<HTMLSelectElement>("job-select");
const svg = document.getElementById("diagram") as unknown as SVGSVGElement;

let flowData: FlowData | null = null;

// ---------- Layout: column per lifecycle phase, stacked within column ----------

const COLUMNS: string[][] = [
  ["job_created"],
  ["tool_ready"],
  ["job_started"],
  ["material_lot_scan", "cycle_completed", "sensor_glitch", "maintenance_ping"],
  ["inspection_passed", "inspection_failed", "shift_handoff"],
  ["job_hold", "job_blocked", "job_unblocked"],
  ["job_completed"],
];
const CLUSTERS = [
  { label: "Production loop", cols: [3, 4] },
  { label: "Deviations", cols: [5] },
];

const COL_WIDTH = 190;
const MARGIN_X = 110;
const HEIGHT = 660;
const WIDTH = MARGIN_X * 2 + COL_WIDTH * (COLUMNS.length - 1);

const NODE_COLOR: Record<string, string> = {
  inspection_passed: "var(--ok)",
  job_completed: "var(--ok)",
  job_unblocked: "var(--ok)",
  inspection_failed: "var(--danger)",
  job_blocked: "var(--danger)",
  sensor_glitch: "var(--warn)",
  job_hold: "var(--warn)",
  maintenance_ping: "var(--warn)",
  shift_handoff: "var(--warn)",
};

interface Placed {
  node: FlowNode;
  x: number;
  y: number;
  r: number;
}

function layout(nodes: FlowNode[]): Map<string, Placed> {
  const present = new Map(nodes.map((n) => [n.event_type, n]));
  const maxEvents = Math.max(...nodes.map((n) => n.events));
  const placed = new Map<string, Placed>();

  COLUMNS.forEach((column, col) => {
    const here = column.filter((t) => present.has(t));
    here.forEach((type, i) => {
      const node = present.get(type)!;
      const x = MARGIN_X + col * COL_WIDTH;
      const y = HEIGHT / 2 + (i - (here.length - 1) / 2) * 150;
      const r = 18 + 26 * Math.sqrt(node.events / maxEvents);
      placed.set(type, { node, x, y, r });
    });
  });
  return placed;
}

// ---------- Rendering ----------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
  if (a === b) {
    // Self-loop above the node.
    return `M ${x1 - a.r * 0.5} ${y1 - a.r * 0.8} C ${x1 - a.r * 1.6} ${y1 - a.r * 2.8}, ${x1 + a.r * 1.6} ${y1 - a.r * 2.8}, ${x1 + a.r * 0.5} ${y1 - a.r * 0.8}`;
  }
  const forward = x2 > x1;
  const dx = Math.abs(x2 - x1);
  if (Math.abs(x2 - x1) < 1) {
    // Same column (e.g. passed <-> failed): bow sideways.
    const bow = 70 + a.r;
    const side = y2 > y1 ? 1 : -1;
    return `M ${x1 + a.r * side * 0} ${y1 + a.r * (y2 > y1 ? 1 : -1)} C ${x1 - bow} ${y1 + 40 * side}, ${x2 - bow} ${y2 - 40 * side}, ${x2} ${y2 + b.r * (y2 > y1 ? -1 : 1)}`;
  }
  if (forward) {
    const sx = x1 + a.r, ex = x2 - b.r;
    return `M ${sx} ${y1} C ${sx + dx * 0.35} ${y1}, ${ex - dx * 0.35} ${y2}, ${ex} ${y2}`;
  }
  // Backward edge: arc underneath.
  const sx = x1 - a.r * 0.4, ex = x2 + b.r * 0.4;
  const drop = Math.max(y1, y2) + 90 + dx * 0.12;
  return `M ${sx} ${y1 + a.r * 0.9} C ${x1 - dx * 0.15} ${drop}, ${x2 + dx * 0.15} ${drop}, ${ex} ${y2 + b.r * 0.9}`;
}

function shortLabel(eventType: string): string {
  return eventType.replace(/_/g, " ");
}

function renderDiagram(): void {
  if (!flowData) return;
  const placed = layout(flowData.nodes);
  const jobId = jobSelect.value;
  const path = jobId ? flowData.job_paths[jobId] ?? [] : null;
  const pathNodes = path ? new Set(path) : null;
  const pathEdges = path
    ? new Set(path.slice(1).map((t, i) => `${path[i]}->${t}`))
    : null;

  const maxEdge = Math.max(...flowData.edges.map((e) => e.count));
  const parts: string[] = [];

  parts.push(`
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="#5a6577"/>
      </marker>
      <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="#4da3ff"/>
      </marker>
    </defs>`);

  // Cluster backgrounds first (behind everything).
  for (const cluster of CLUSTERS) {
    const xs = cluster.cols.map((c) => MARGIN_X + c * COL_WIDTH);
    const hasNodes = cluster.cols.some((c) =>
      COLUMNS[c].some((t) => placed.has(t))
    );
    if (!hasNodes) continue;
    const x = Math.min(...xs) - 85;
    const w = Math.max(...xs) - Math.min(...xs) + 170;
    parts.push(`
      <rect x="${x}" y="26" width="${w}" height="${HEIGHT - 46}" rx="16"
            fill="rgba(77,163,255,0.04)" stroke="var(--border)" stroke-dasharray="5 5"/>
      <text x="${x + w / 2}" y="50" text-anchor="middle" class="cluster-label">${cluster.label}</text>`);
  }

  // Edges.
  for (const edge of flowData.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b) continue;
    const onPath = pathEdges?.has(`${edge.from}->${edge.to}`) ?? false;
    const dimmed = pathEdges !== null && !onPath;
    const width = 1.2 + 5 * (Math.log(1 + edge.count) / Math.log(1 + maxEdge));
    parts.push(`
      <g class="edge ${dimmed ? "dimmed" : ""}">
        <path d="${edgePath(a, b)}" fill="none"
              stroke="${onPath ? "#4da3ff" : "#5a6577"}" stroke-width="${width.toFixed(1)}"
              opacity="${onPath ? 1 : 0.75}" marker-end="url(#${onPath ? "arrow-hl" : "arrow"})">
          <title>${edge.from} → ${edge.to}: ${edge.count} transition${edge.count === 1 ? "" : "s"}</title>
        </path>
      </g>`);
  }

  // Nodes.
  for (const { node, x, y, r } of placed.values()) {
    const color = NODE_COLOR[node.event_type] ?? "var(--accent)";
    const dimmed = pathNodes !== null && !pathNodes.has(node.event_type);
    parts.push(`
      <g class="node ${dimmed ? "dimmed" : ""}" data-node="${node.event_type}" transform="translate(${x},${y})">
        <circle r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2"/>
        <text y="${r + 18}" text-anchor="middle" class="node-label">${shortLabel(node.event_type)}</text>
        <text y="${r + 34}" text-anchor="middle" class="node-sub">${node.events.toLocaleString()} ev / ${node.jobs} job${node.jobs === 1 ? "" : "s"}</text>
        <title>${node.event_type}: ${node.events.toLocaleString()} events across ${node.jobs} jobs</title>
      </g>`);
  }

  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  svg.innerHTML = parts.join("");
}

function renderFunnel(): void {
  if (!flowData) return;
  const f = flowData.funnel;
  const pct = f.created ? Math.round((100 * f.completed) / f.created) : 0;
  $("funnel").innerHTML = `
    <span class="funnel-step">Jobs created <strong>${f.created}</strong></span>
    <span class="funnel-arrow">&rarr;</span>
    <span class="funnel-step">Started <strong>${f.started}</strong></span>
    <span class="funnel-arrow">&rarr;</span>
    <span class="funnel-step">Completed <strong>${f.completed}</strong></span>
    <span class="funnel-pct ${pct >= 80 ? "good" : pct >= 50 ? "mid" : "low"}">${pct}% complete</span>`;
  $("funnel").classList.remove("hidden");
}

// ---------- Drawer ----------

async function openNodeDrawer(eventType: string): Promise<void> {
  if (!flowData) return;
  const node = flowData.nodes.find((n) => n.event_type === eventType);
  if (!node) return;

  $("drawer-title").textContent = shortLabel(eventType);
  const body = $("drawer-body");

  const breakdown = node.breakdown.length
    ? `<h3>${escapeHtml(node.breakdown_field ?? "")} breakdown</h3>
       <ul class="breakdown">${node.breakdown
         .map((b) => {
           const w = Math.round((100 * b.count) / node.breakdown[0].count);
           return `<li><span class="bd-label">${escapeHtml(String(b.value))}</span>
                   <span class="bd-bar"><span style="width:${w}%"></span></span>
                   <span class="bd-count">${b.count}</span></li>`;
         })
         .join("")}</ul>`
    : "";

  body.innerHTML = `
    <dl class="stage-summary">
      <dt>Events</dt><dd>${node.events.toLocaleString()}</dd>
      <dt>Jobs</dt><dd>${node.jobs} of ${flowData.jobs.length}</dd>
      <dt>First seen</dt><dd>${node.first.replace("T", " ").replace("Z", "")}</dd>
      <dt>Last seen</dt><dd>${node.last.replace("T", " ").replace("Z", "")}</dd>
    </dl>
    ${breakdown}
    <h3>Recent events</h3>
    <div class="recent-events">Loading…</div>`;

  $("drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");

  const params = new URLSearchParams({
    part_id: flowData.part_id,
    event_type: eventType,
    page_size: "10",
    sort_dir: "desc",
  });
  if (jobSelect.value) params.set("job_id", jobSelect.value);
  const res = await fetch(`/api/events?${params}`);
  if (res.status === 401) {
    sessionExpired();
    return;
  }
  const data = (await res.json()) as {
    total: number;
    items: { timestamp: string; event_id: string; job_id: string | null; metadata: Record<string, unknown> | null }[];
  };
  const target = body.querySelector(".recent-events")!;
  target.innerHTML = `
    <p class="dim-note">${data.total.toLocaleString()} matching event${data.total === 1 ? "" : "s"}${jobSelect.value ? ` for ${escapeHtml(jobSelect.value)}` : ""}; latest 10:</p>
    <ul class="event-list">${data.items
      .map(
        (e) => `<li><code>${e.timestamp.replace("T", " ").replace("Z", "")}</code>
                <span>${escapeHtml(e.job_id ?? "")}</span>
                <span class="dim">${escapeHtml(e.event_id)}</span></li>`
      )
      .join("")}</ul>`;
}

function closeDrawer(): void {
  $("drawer").classList.add("hidden");
  $("drawer-backdrop").classList.add("hidden");
}

// ---------- Data loading ----------

async function loadFlow(partId: string): Promise<void> {
  const res = await fetch(`/api/flow?part_id=${encodeURIComponent(partId)}`);
  if (res.status === 401) {
    sessionExpired();
    return;
  }
  if (!res.ok) {
    $("flow-hint").textContent = `Failed to load flow (${res.status})`;
    return;
  }
  flowData = (await res.json()) as FlowData;

  jobSelect.innerHTML = `<option value="">All jobs (aggregate)</option>`;
  for (const job of flowData.jobs) {
    jobSelect.add(new Option(job, job));
  }
  jobSelect.disabled = false;

  $("flow-hint").textContent = "";
  renderFunnel();
  renderDiagram();
}

partSelect.addEventListener("change", () => {
  closeDrawer();
  if (partSelect.value) {
    void loadFlow(partSelect.value);
  } else {
    flowData = null;
    svg.innerHTML = "";
    jobSelect.innerHTML = `<option value="">All jobs (aggregate)</option>`;
    jobSelect.disabled = true;
    $("funnel").classList.add("hidden");
    $("flow-hint").textContent = "Choose a part to see its factory flow.";
  }
});

jobSelect.addEventListener("change", () => {
  closeDrawer();
  renderDiagram();
});

svg.addEventListener("click", (e) => {
  const group = (e.target as Element).closest("g.node");
  if (group) void openNodeDrawer(group.getAttribute("data-node")!);
});

$("drawer-close").addEventListener("click", closeDrawer);
$("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

void ensureAuth().then(async (user) => {
  wireUserBox(user);
  const res = await fetch("/api/meta");
  if (res.status === 401) {
    sessionExpired();
    return;
  }
  const meta = (await res.json()) as { parts: string[] };
  for (const part of meta.parts) {
    partSelect.add(new Option(part, part));
  }
});
