import { ensureAuth, wireUserBox, sessionExpired } from "./auth.js";

interface LogEvent {
  event_id: string;
  timestamp: string;
  event_type: string;
  job_id: string | null;
  part_id: string | null;
  customer_id: string | null;
  machine_id: string | null;
  material: string | null;
  quantity: number | null;
  metadata: Record<string, unknown> | null;
}

interface EventsResponse {
  total: number;
  page: number;
  page_size: number;
  pages: number;
  items: LogEvent[];
}

interface Meta {
  event_types: string[];
  machines: string[];
  jobs: string[];
  parts: string[];
  customers: string[];
  materials: string[];
  facilities: string[];
  total: number;
}

interface Stats {
  total: number;
  by_type: { event_type: string; count: number }[];
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const startDate = $<HTMLInputElement>("start-date");
const startTime = $<HTMLInputElement>("start-time");
const endDate = $<HTMLInputElement>("end-date");
const endTime = $<HTMLInputElement>("end-time");
const rangeInputs = [startDate, startTime, endDate, endTime];
const pageSizeSelect = $<HTMLSelectElement>("page-size");
const tbody = $<HTMLTableSectionElement>("log-body");
const tsHeader = $<HTMLTableCellElement>("ts-header");

// Dropdown filters: element id -> API query parameter.
const FILTERS: Record<string, string> = {
  "event-type": "event_type",
  part: "part_id",
  machine: "machine_id",
  customer: "customer_id",
  material: "material",
  facility: "facility",
};
const filterSelects = Object.fromEntries(
  Object.keys(FILTERS).map((id) => [id, $<HTMLSelectElement>(id)])
);

// Job filter is a type-ahead input validated against the known job IDs.
const jobInput = $<HTMLInputElement>("job");
const knownJobs = new Set<string>();

const state = {
  page: 1,
  pages: 1,
  sortDir: "desc" as "asc" | "desc",
  events: [] as LogEvent[],
};

const BADGE_CLASS: Record<string, string> = {
  inspection_passed: "ok",
  job_completed: "ok",
  job_unblocked: "ok",
  inspection_failed: "bad",
  job_blocked: "bad",
  sensor_glitch: "warn",
  job_hold: "warn",
  maintenance_ping: "warn",
};

function buildQuery(): string {
  const params = new URLSearchParams({
    page: String(state.page),
    page_size: pageSizeSelect.value,
    sort_dir: state.sortDir,
  });
  for (const [id, param] of Object.entries(FILTERS)) {
    const value = filterSelects[id].value;
    if (value) params.set(param, value);
  }
  // Only apply the job filter once the text is a real job ID.
  const job = jobInput.value.trim();
  if (job && knownJobs.has(job)) params.set("job_id", job);
  // The table displays timestamps in UTC, so treat the picker values as UTC
  // too instead of converting from the browser's local timezone. A date with
  // no time covers the whole day (00:00 for From, 23:59 for To).
  if (startDate.value) params.set("start", `${startDate.value}T${startTime.value || "00:00"}:00Z`);
  if (endDate.value) params.set("end", `${endDate.value}T${endTime.value || "23:59"}:59Z`);
  return params.toString();
}

function metaField(event: LogEvent, key: string): string | null {
  const value = event.metadata?.[key];
  return value == null || value === "" ? null : String(value);
}

function cell(text: string | number | null, cls = ""): string {
  const value = text === null || text === "" ? "—" : String(text);
  const dim = value === "—" ? " dim" : "";
  return `<td class="${cls}${dim}">${escapeHtml(value)}</td>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function render(data: EventsResponse): void {
  state.pages = data.pages;
  state.events = data.items;

  tbody.innerHTML = data.items
    .map((e, i) => {
      const badge = BADGE_CLASS[e.event_type] ?? "";
      return `<tr data-idx="${i}">
        ${cell(e.timestamp.replace("T", " ").replace("Z", ""))}
        <td><span class="badge ${badge}">${escapeHtml(e.event_type)}</span></td>
        ${cell(e.event_id)}
        ${cell(e.job_id)}
        ${cell(e.part_id)}
        ${cell(e.machine_id)}
        ${cell(e.customer_id)}
        ${cell(e.material)}
        ${cell(metaField(e, "facility"))}
        ${cell(e.quantity, "num")}
        <td><button type="button" class="btn btn-row" data-action="meta" data-idx="${i}">Metadata</button></td>
        <td><button type="button" class="btn btn-row" data-action="raw" data-idx="${i}">Raw log</button></td>
      </tr>`;
    })
    .join("");

  $("empty").classList.toggle("hidden", data.items.length > 0);
  const first = data.total === 0 ? 0 : (data.page - 1) * data.page_size + 1;
  const last = Math.min(data.page * data.page_size, data.total);
  $("page-info").textContent = `${first}–${last} of ${data.total.toLocaleString()} events`;
  ($<HTMLButtonElement>("prev")).disabled = data.page <= 1;
  ($<HTMLButtonElement>("next")).disabled = data.page >= data.pages;

  tsHeader.classList.toggle("sorted-asc", state.sortDir === "asc");
  tsHeader.classList.toggle("sorted-desc", state.sortDir === "desc");
}

async function load(): Promise<void> {
  const res = await fetch(`/api/events?${buildQuery()}`);
  if (res.status === 401) {
    sessionExpired();
    return;
  }
  if (!res.ok) {
    tbody.innerHTML = "";
    $("page-info").textContent = `Error loading events (${res.status})`;
    return;
  }
  render((await res.json()) as EventsResponse);
}

function fillSelect(select: HTMLSelectElement, values: string[]): void {
  for (const v of values) {
    select.add(new Option(v, v));
  }
}

let metaLoaded = false;

async function loadMeta(): Promise<void> {
  if (metaLoaded) return;
  metaLoaded = true;
  const [meta, stats] = await Promise.all([
    fetch("/api/meta").then((r) => r.json() as Promise<Meta>),
    fetch("/api/stats").then((r) => r.json() as Promise<Stats>),
  ]);

  fillSelect(filterSelects["event-type"], meta.event_types);
  fillSelect(filterSelects["part"], meta.parts);
  fillSelect(filterSelects["machine"], meta.machines);
  fillSelect(filterSelects["customer"], meta.customers);
  fillSelect(filterSelects["material"], meta.materials);
  fillSelect(filterSelects["facility"], meta.facilities);

  const datalist = $<HTMLDataListElement>("job-options");
  for (const job of meta.jobs) {
    knownJobs.add(job);
    datalist.appendChild(new Option(job));
  }

  const top = stats.by_type.slice(0, 4);
  $("stats").innerHTML = [
    `<span class="stat-chip">${stats.total.toLocaleString()} events</span>`,
    ...top.map(
      (t) => `<span class="stat-chip">${escapeHtml(t.event_type)}: ${t.count.toLocaleString()}</span>`
    ),
  ].join("");
}

function splitIso(iso: string): { date: string; time: string } | null {
  const match = iso.replace("Z", "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? { date: match[1], time: match[2] } : null;
}

function applyUrlFilters(): void {
  const q = new URLSearchParams(location.search);
  const eventType = q.get("event_type");
  if (eventType) filterSelects["event-type"].value = eventType;
  const part = q.get("part_id");
  if (part) filterSelects["part"].value = part;
  const machine = q.get("machine_id");
  if (machine) filterSelects["machine"].value = machine;
  const customer = q.get("customer_id");
  if (customer) filterSelects["customer"].value = customer;
  const material = q.get("material");
  if (material) filterSelects["material"].value = material;
  const facility = q.get("facility");
  if (facility) filterSelects["facility"].value = facility;
  const job = q.get("job_id");
  if (job) {
    jobInput.value = job;
    jobInput.classList.toggle("invalid", !knownJobs.has(job));
  }
  const start = q.get("start");
  if (start) {
    const parsed = splitIso(start);
    if (parsed) {
      startDate.value = parsed.date;
      startTime.value = parsed.time;
    }
  }
  const end = q.get("end");
  if (end) {
    const parsed = splitIso(end);
    if (parsed) {
      endDate.value = parsed.date;
      endTime.value = parsed.time;
    }
  }
  if (start || end) state.sortDir = "asc";
}

function openDrawer(title: string, payload: unknown): void {
  $("drawer-title").textContent = title;
  $("drawer-json").textContent =
    payload == null ? "No metadata on this event." : JSON.stringify(payload, null, 2);
  $("drawer").classList.remove("hidden");
  $("drawer-backdrop").classList.remove("hidden");
}

function closeDrawer(): void {
  $("drawer").classList.add("hidden");
  $("drawer-backdrop").classList.add("hidden");
}

function resetAndLoad(): void {
  state.page = 1;
  void load();
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}

for (const select of Object.values(filterSelects)) {
  select.addEventListener("change", resetAndLoad);
}
pageSizeSelect.addEventListener("change", resetAndLoad);

jobInput.addEventListener(
  "input",
  debounce(() => {
    const value = jobInput.value.trim();
    jobInput.classList.toggle("invalid", value !== "" && !knownJobs.has(value));
    resetAndLoad();
  }, 250)
);

// Changing the time range always takes over the sort: chronological from the
// start of the range when one is set, back to newest-first when cleared.
function applyTimeRange(): void {
  state.sortDir = startDate.value || endDate.value ? "asc" : "desc";
  resetAndLoad();
}
for (const input of rangeInputs) {
  input.addEventListener("change", applyTimeRange);
}

$("clear").addEventListener("click", () => {
  for (const select of Object.values(filterSelects)) {
    select.value = "";
  }
  jobInput.value = "";
  jobInput.classList.remove("invalid");
  for (const input of rangeInputs) {
    input.value = "";
  }
  state.sortDir = "desc";
  resetAndLoad();
});

$("prev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    void load();
  }
});

$("next").addEventListener("click", () => {
  if (state.page < state.pages) {
    state.page += 1;
    void load();
  }
});

tsHeader.addEventListener("click", () => {
  state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  resetAndLoad();
});

tbody.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button[data-action]") as HTMLButtonElement | null;
  if (!btn) return;
  const event = state.events[Number(btn.dataset.idx)];
  if (!event) return;
  if (btn.dataset.action === "meta") {
    const meta = event.metadata;
    const empty = meta == null || Object.keys(meta).length === 0;
    openDrawer(
      `Metadata — ${event.event_id}`,
      empty ? null : meta
    );
  } else if (btn.dataset.action === "raw") {
    openDrawer(`${event.event_id} — ${event.event_type}`, event);
  }
});

$("drawer-close").addEventListener("click", closeDrawer);
$("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

void ensureAuth().then(async (user) => {
  wireUserBox(user);
  await loadMeta();
  applyUrlFilters();
  void load();
});
