import { ensureAuth, wireUserBox, sessionExpired } from "./auth.js";

interface FlowNode {
  event_type: string;
  events: number;
  jobs: number;
  job_counts: { job_id: string; count: number }[];
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

interface JobStep {
  step: number;
  event_type: string;
  count: number;
  first: string;
  last: string;
  metadata: Record<string, unknown> | null;
}

interface JobStory {
  job_id: string;
  outcome: "completed" | "stalled";
  last_stage: string | null;
  good_quantity: number | null;
  scrap_quantity: number | null;
  steps: JobStep[];
}

interface FlowData {
  part_id: string;
  jobs: string[];
  funnel: { total_jobs: number; created: number; started: number; completed: number };
  nodes: FlowNode[];
  edges: FlowEdge[];
  job_stories: Record<string, JobStory>;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const partSelect = $<HTMLSelectElement>("part-select");
const jobSelect = $<HTMLSelectElement>("job-select");
const svg = document.getElementById("diagram") as unknown as SVGSVGElement;
const diagramWrap = $("diagram-wrap");
const timelineEl = $("timeline");
const emptyFlow = $("empty-flow");

let flowData: FlowData | null = null;

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function fmtTs(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

function logsHref(opts: {
  part_id?: string;
  job_id?: string;
  event_type?: string;
  start?: string;
  end?: string;
}): string {
  const params = new URLSearchParams();
  if (opts.part_id) params.set("part_id", opts.part_id);
  if (opts.job_id) params.set("job_id", opts.job_id);
  if (opts.event_type) params.set("event_type", opts.event_type);
  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);
  return `/logs?${params.toString()}`;
}

function logsLink(href: string, label: string): string {
  return `<a class="logs-link" href="${href}">${label} →</a>`;
}

function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
  if (a === b) {
    return `M ${x1 - a.r * 0.5} ${y1 - a.r * 0.8} C ${x1 - a.r * 1.6} ${y1 - a.r * 2.8}, ${x1 + a.r * 1.6} ${y1 - a.r * 2.8}, ${x1 + a.r * 0.5} ${y1 - a.r * 0.8}`;
  }
  const forward = x2 > x1;
  const dx = Math.abs(x2 - x1);
  if (Math.abs(x2 - x1) < 1) {
    const bow = 70 + a.r;
    const side = y2 > y1 ? 1 : -1;
    return `M ${x1} ${y1 + a.r * (y2 > y1 ? 1 : -1)} C ${x1 - bow} ${y1 + 40 * side}, ${x2 - bow} ${y2 - 40 * side}, ${x2} ${y2 + b.r * (y2 > y1 ? -1 : 1)}`;
  }
  if (forward) {
    const sx = x1 + a.r, ex = x2 - b.r;
    return `M ${sx} ${y1} C ${sx + dx * 0.35} ${y1}, ${ex - dx * 0.35} ${y2}, ${ex} ${y2}`;
  }
  const sx = x1 - a.r * 0.4, ex = x2 + b.r * 0.4;
  const drop = Math.max(y1, y2) + 90 + dx * 0.12;
  return `M ${sx} ${y1 + a.r * 0.9} C ${x1 - dx * 0.15} ${drop}, ${x2 + dx * 0.15} ${drop}, ${ex} ${y2 + b.r * 0.9}`;
}

function shortLabel(eventType: string): string {
  return eventType.replace(/_/g, " ");
}

function toneClass(eventType: string): string {
  if (["inspection_passed", "job_completed", "job_unblocked"].includes(eventType)) return "ok";
  if (["inspection_failed", "job_blocked"].includes(eventType)) return "bad";
  if (["sensor_glitch", "job_hold", "maintenance_ping", "shift_handoff"].includes(eventType)) return "warn";
  return "";
}

function selectedStory(): JobStory | null {
  if (!flowData || !jobSelect.value) return null;
  return flowData.job_stories[jobSelect.value] ?? null;
}

function renderDiagram(): void {
  if (!flowData) return;
  const placed = layout(flowData.nodes);
  const maxEdge = Math.max(...flowData.edges.map((e) => e.count), 1);
  const parts: string[] = [];

  parts.push(`
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="#5a6577"/>
      </marker>
    </defs>`);

  for (const cluster of CLUSTERS) {
    const xs = cluster.cols.map((c) => MARGIN_X + c * COL_WIDTH);
    const hasNodes = cluster.cols.some((c) => COLUMNS[c].some((t) => placed.has(t)));
    if (!hasNodes) continue;
    const x = Math.min(...xs) - 85;
    const w = Math.max(...xs) - Math.min(...xs) + 170;
    parts.push(`
      <rect x="${x}" y="26" width="${w}" height="${HEIGHT - 46}" rx="16"
            fill="rgba(77,163,255,0.04)" stroke="var(--border)" stroke-dasharray="5 5"/>
      <text x="${x + w / 2}" y="50" text-anchor="middle" class="cluster-label">${cluster.label}</text>`);
  }

  for (const edge of flowData.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b) continue;
    const width = 1.2 + 5 * (Math.log(1 + edge.count) / Math.log(1 + maxEdge));
    parts.push(`
      <g class="edge">
        <path d="${edgePath(a, b)}" fill="none" stroke="#5a6577" stroke-width="${width.toFixed(1)}"
              opacity="0.75" marker-end="url(#arrow)">
          <title>${edge.from} → ${edge.to}: ${edge.count} transition${edge.count === 1 ? "" : "s"}</title>
        </path>
      </g>`);
  }

  for (const { node, x, y, r } of placed.values()) {
    const color = NODE_COLOR[node.event_type] ?? "var(--accent)";
    parts.push(`
      <g class="node" data-node="${node.event_type}" transform="translate(${x},${y})">
        <circle r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="2"/>
        <text y="${r + 18}" text-anchor="middle" class="node-label">${shortLabel(node.event_type)}</text>
        <text y="${r + 34}" text-anchor="middle" class="node-sub">${node.events.toLocaleString()} ev / ${node.jobs} job${node.jobs === 1 ? "" : "s"}</text>
        <title>${node.event_type}: ${node.events.toLocaleString()} events across ${node.jobs} jobs</title>
      </g>`);
  }

  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  svg.innerHTML = parts.join("");
}

function renderTimeline(story: JobStory): void {
  const stalled = story.outcome === "stalled";
  timelineEl.innerHTML = story.steps
    .map((s, i) => {
      const last = i === story.steps.length - 1;
      const tone = last && stalled ? "stalled" : toneClass(s.event_type);
      const when =
        s.count > 1 && s.first !== s.last
          ? `${fmtTs(s.first)} → ${fmtTs(s.last)}`
          : fmtTs(s.first);
      const extra =
        last && story.outcome === "completed" && story.good_quantity !== null
          ? `<span class="tl-qty">${story.good_quantity} good / ${story.scrap_quantity ?? 0} scrap</span>`
          : last && stalled
            ? `<span class="tl-qty">stalled here</span>`
            : "";
      const count = s.count > 1 ? `<span class="tl-count">×${s.count}</span>` : "";
      const arrow = i < story.steps.length - 1 ? `<span class="tl-arrow" aria-hidden="true">→</span>` : "";
      return `
        <button type="button" class="tl-step ${tone}" data-step="${s.step}">
          <span class="tl-num">${s.step}</span>
          <span class="tl-name">${escapeHtml(shortLabel(s.event_type))} ${count}</span>
          <span class="tl-time">${when}</span>
          ${extra}
        </button>
        ${arrow}`;
    })
    .join("");
}

function renderFunnel(): void {
  if (!flowData) return;
  const story = selectedStory();
  if (story) {
    const outcome =
      story.outcome === "completed"
        ? `<span class="funnel-pct good">completed · ${story.good_quantity ?? "?"} good / ${story.scrap_quantity ?? 0} scrap</span>`
        : `<span class="funnel-pct low">stalled at ${escapeHtml(shortLabel(story.last_stage ?? "unknown"))}</span>`;
    $("funnel").innerHTML = `
      <span class="funnel-step">Job <strong>${escapeHtml(story.job_id)}</strong></span>
      <span class="funnel-arrow">&rarr;</span>
      <span class="funnel-step">${story.steps.length} step${story.steps.length === 1 ? "" : "s"}</span>
      ${outcome}
      ${logsLink(
        logsHref({
          part_id: flowData.part_id,
          job_id: story.job_id,
          start: story.steps[0]?.first,
          end: story.steps[story.steps.length - 1]?.last,
        }),
        "Open logs for this job"
      )}`;
  } else {
    const f = flowData.funnel;
    const pct = f.created ? Math.round((100 * f.completed) / f.created) : 0;
    $("funnel").innerHTML = `
      <span class="funnel-step">Jobs created <strong>${f.created}</strong></span>
      <span class="funnel-arrow">&rarr;</span>
      <span class="funnel-step">Started <strong>${f.started}</strong></span>
      <span class="funnel-arrow">&rarr;</span>
      <span class="funnel-step">Completed <strong>${f.completed}</strong></span>
      <span class="funnel-pct ${pct >= 80 ? "good" : pct >= 50 ? "mid" : "low"}">${pct}% complete</span>
      ${logsLink(logsHref({ part_id: flowData.part_id }), "Open logs for this part")}`;
  }
  $("funnel").classList.remove("hidden");
}

function renderView(): void {
  if (!flowData) return;
  emptyFlow.classList.add("hidden");
  const story = selectedStory();
  renderFunnel();
  if (story) {
    diagramWrap.classList.add("hidden");
    timelineEl.classList.remove("hidden");
    renderTimeline(story);
  } else {
    timelineEl.classList.add("hidden");
    timelineEl.innerHTML = "";
    diagramWrap.classList.remove("hidden");
    renderDiagram();
  }
}

function openNodeDrawer(eventType: string): void {
  if (!flowData) return;
  const partId = flowData.part_id;
  const node = flowData.nodes.find((n) => n.event_type === eventType);
  if (!node) return;

  $("drawer-title").textContent = shortLabel(eventType);
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

  const jobList = node.job_counts.length
    ? `<h3>Jobs in this stage</h3>
       <ul class="breakdown">${node.job_counts
         .map((j) => {
           const w = Math.round((100 * j.count) / node.job_counts[0].count);
           const href = logsHref({
             part_id: partId,
             job_id: j.job_id,
             event_type: eventType,
           });
           return `<li>
             <a class="bd-label" href="${href}">${escapeHtml(j.job_id)}</a>
             <span class="bd-bar"><span style="width:${w}%"></span></span>
             <span class="bd-count">${j.count}</span>
           </li>`;
         })
         .join("")}</ul>`
    : "";

  $("drawer-body").innerHTML = `
    <dl class="stage-summary">
      <dt>Events</dt><dd>${node.events.toLocaleString()}</dd>
      <dt>Jobs</dt><dd>${node.jobs} of ${flowData.jobs.length}</dd>
      <dt>First seen</dt><dd>${fmtTs(node.first)}</dd>
      <dt>Last seen</dt><dd>${fmtTs(node.last)}</dd>
    </dl>
    ${jobList}
    ${breakdown}
    ${logsLink(
      logsHref({
        part_id: partId,
        event_type: eventType,
        start: node.first,
        end: node.last,
      }),
      "View these events in logs"
    )}`;

  $("drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");
}

function openStepDrawer(step: JobStep, story: JobStory): void {
  $("drawer-title").textContent = `Step ${step.step} — ${shortLabel(step.event_type)}`;
  const when =
    step.count > 1 && step.first !== step.last
      ? `${fmtTs(step.first)} → ${fmtTs(step.last)}`
      : fmtTs(step.first);
  const meta = step.metadata && Object.keys(step.metadata).length
    ? `<h3>Details</h3><pre>${escapeHtml(JSON.stringify(step.metadata, null, 2))}</pre>`
    : "";
  const outcome =
    step.event_type === "job_completed" && story.good_quantity !== null
      ? `<dt>Yield</dt><dd>${story.good_quantity} good / ${story.scrap_quantity ?? 0} scrap</dd>`
      : "";
  $("drawer-body").innerHTML = `
    <dl class="stage-summary">
      <dt>Job</dt><dd>${escapeHtml(story.job_id)}</dd>
      <dt>Step</dt><dd>${step.step} of ${story.steps.length}</dd>
      <dt>When</dt><dd>${when}</dd>
      <dt>Events</dt><dd>${step.count}${step.count > 1 ? " consecutive" : ""}</dd>
      ${outcome}
    </dl>
    ${meta}
    ${logsLink(
      logsHref({
        part_id: flowData!.part_id,
        job_id: story.job_id,
        event_type: step.event_type,
        start: step.first,
        end: step.last,
      }),
      step.count > 1 ? "View this step in logs" : "View this event in logs"
    )}`;
  $("drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");
}

function closeDrawer(): void {
  $("drawer").classList.add("hidden");
  $("drawer-backdrop").classList.add("hidden");
}

async function loadFlow(partId: string): Promise<void> {
  const res = await fetch(`/api/flow?part_id=${encodeURIComponent(partId)}`);
  if (res.status === 401) {
    sessionExpired();
    return;
  }
  if (!res.ok) {
    emptyFlow.classList.remove("hidden");
    emptyFlow.innerHTML = `<p>Could not load this part.</p><p>Failed to load flow (${res.status}).</p>`;
    return;
  }
  flowData = (await res.json()) as FlowData;

  jobSelect.innerHTML = `<option value="">All jobs (part map)</option>`;
  for (const job of flowData.jobs) {
    const story = flowData.job_stories[job];
    const label = story?.outcome === "stalled" ? `${job} (stalled)` : job;
    jobSelect.add(new Option(label, job));
  }
  jobSelect.disabled = false;
  renderView();
}

function clearPart(): void {
  flowData = null;
  svg.innerHTML = "";
  timelineEl.innerHTML = "";
  timelineEl.classList.add("hidden");
  diagramWrap.classList.add("hidden");
  $("funnel").classList.add("hidden");
  jobSelect.innerHTML = `<option value="">All jobs (part map)</option>`;
  jobSelect.disabled = true;
  emptyFlow.innerHTML = `
    <p>No part selected.</p>
    <p>Please select a part at the top left to see its factory flow.</p>`;
  emptyFlow.classList.remove("hidden");
}

partSelect.addEventListener("change", () => {
  closeDrawer();
  if (partSelect.value) void loadFlow(partSelect.value);
  else clearPart();
});

jobSelect.addEventListener("change", () => {
  closeDrawer();
  renderView();
});

svg.addEventListener("click", (e) => {
  const group = (e.target as Element).closest("g.node");
  if (group) openNodeDrawer(group.getAttribute("data-node")!);
});

timelineEl.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button.tl-step") as HTMLButtonElement | null;
  const story = selectedStory();
  if (!btn || !story) return;
  const step = story.steps.find((s) => s.step === Number(btn.dataset.step));
  if (step) openStepDrawer(step, story);
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
