/* global document, fetch, EventSource, CSS, location, setTimeout, clearTimeout, window, matchMedia, requestAnimationFrame, performance, navigator, CustomEvent, Element */
// Static and streaming pages share disclosure behavior. Live HTML always comes from runFragments.
const script = document.querySelector("script[data-run]");
const [suite, run] = script.dataset.run.split("/");
const base = `/r/${encodeURIComponent(suite)}/${encodeURIComponent(run)}`;
const api = `/api/runs/${encodeURIComponent(suite)}/${encodeURIComponent(run)}`;
const $ = (s) => document.querySelector(s);
// "lost" is not terminal: the hub lets an agent claim a lost run again, so the stream stays open.
const terminal = new Set(["finished", "failed", "cancelled"]);
const openEngineers = () => {
  if (location.hash === "#engineers") {
    const drawer = $("#engineers");
    if (drawer) drawer.open = true;
  }
};
openEngineers();
window.addEventListener("hashchange", openEngineers);

let copyTimer = 0;
document.addEventListener("click", async (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest("[data-copy-summary]")
      : null;
  if (!button) return;
  const share = button.closest("[data-share]");
  const field = share.querySelector("textarea");
  const feedback = share.querySelector("[data-copy-status]");
  clearTimeout(copyTimer);
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = "Copied";
    feedback.textContent = "Copied";
    share.querySelector("[data-copy-fallback]").hidden = true;
    copyTimer = setTimeout(() => {
      button.textContent = "Copy summary";
      feedback.textContent = "";
    }, 2000);
  } catch {
    button.textContent = "Copy summary";
    share.querySelector("[data-copy-fallback]").hidden = false;
    feedback.textContent = "Select and copy";
    field.focus();
    field.select();
  } finally {
    button.disabled = false;
  }
});

let total = Number(script.dataset.total || 0);
let finished = Number(script.dataset.finished || 0);
let ended = false;
let animated = false;
let refreshing = false;
let dirty = false;
let timer = 0;
let lost = false;
let retries = 0;

function progress() {
  const p = $("[data-progress]");
  if (p)
    p.textContent = total
      ? ended
        ? `Graded ${finished} of ${total} cases.`
        : lost
          ? `Lost contact with the agent after ${finished} of ${total} cases.`
          : finished < total
            ? `Grading case ${finished + 1} of ${total}`
            : `Graded ${finished} of ${total} cases. Finishing the comparison.`
      : "Waiting for the agent.";
  const bar = $("[data-progress-bar]");
  if (bar)
    bar.style.transform = `scaleX(${total ? Math.min(1, Math.max(0, finished / total)) : 0})`;
}

function status(s) {
  lost = s === "lost";
  const el = $("[data-status]");
  if (el) {
    el.className = `status ${s}`;
    el.lastChild.textContent = s;
  }
}

function countUp() {
  if (animated || !$("[data-complete=true]")) return;
  animated = true;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cells = [...document.querySelectorAll("[data-count]")];
  cells.forEach((el) => el.setAttribute("aria-label", el.textContent));
  const start = performance.now();
  const frame = (now) => {
    const fraction = Math.min(1, (now - start) / 600);
    cells.forEach((el) => {
      const digits = Number(el.dataset.digits);
      el.textContent =
        el.dataset.prefix +
        (Number(el.dataset.count) * fraction).toLocaleString("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });
    });
    if (fraction < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function refresh() {
  if (refreshing) {
    dirty = true;
    return;
  }
  refreshing = true;
  dirty = false;
  try {
    const response = await fetch(`${base}/fragments${location.search}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404 || response.status === 410) {
      // The run is gone. Stop polling instead of retrying forever.
      ended = true;
      es?.close();
      return;
    }
    if (!response.ok) throw new Error("Fragments unavailable");
    retries = 0;
    const f = await response.json();
    const openCases = [
      ...document.querySelectorAll("tr[data-case] details[open]"),
    ].map((el) => el.closest("tr").dataset.case);
    for (const name of [
      "verdict",
      "share",
      "changed",
      "checks",
      "ledger",
      "cost",
      "engineers",
    ]) {
      const el = $(`[data-section="${name}"]`);
      if (el && typeof f[name] === "string") el.innerHTML = f[name];
    }
    for (const id of openCases) {
      const detail = $(`tr[data-case="${CSS.escape(id)}"] details`);
      if (detail) {
        detail.dataset.analyticsRestored = "";
        detail.open = true;
      }
    }
    total = f.total;
    finished = f.finished;
    status(f.status);
    const share = $("[data-share]");
    if (share) share.hidden = f.status !== "finished";
    if (terminal.has(f.status)) {
      ended = true;
      es?.close();
      clearTimeout(timer);
      dirty = false;
      countUp();
      if (f.status === "finished")
        document.dispatchEvent(new CustomEvent("weigh:run-finished"));
    }
    progress();
  } catch {
    // Retry the final fetch too: completion must not depend on another event arriving.
    // Back off and give up after eight misses so a dead run never polls forever.
    retries += 1;
    dirty = retries <= 8;
  } finally {
    refreshing = false;
    if (dirty)
      timer = setTimeout(refresh, Math.min(30000, 1500 * 2 ** retries));
  }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 400);
}
function finish() {
  if (ended) return;
  ended = true;
  es.close();
  schedule();
}

const es =
  script.dataset.live === "true"
    ? new EventSource(
        `${api}/events?since=${Number(script.dataset.since || 0)}`,
      )
    : null;
if (es) {
  es.addEventListener("run_start", (e) => {
    const d = JSON.parse(e.data);
    total = d.total + d.resumed;
    finished = d.resumed;
    status("running");
    progress();
    schedule();
  });
  es.addEventListener("job_done", (e) => {
    const d = JSON.parse(e.data);
    finished = d.finished + Math.max(0, total - d.total);
    progress();
    const row = $(`tr[data-case="${CSS.escape(d.line.case_id)}"]`);
    if (row) {
      row.classList.remove("live-new");
      void row.offsetWidth;
      row.classList.add("live-new");
    }
    schedule();
  });
  es.addEventListener("summary", schedule);
  es.addEventListener("status", (e) => {
    const d = JSON.parse(e.data);
    status(d.status);
    if (terminal.has(d.status)) finish();
  });
  es.addEventListener("end", finish);
  es.onerror = () => {
    /* EventSource reconnects using Last-Event-ID. */
  };
}
