/* global document, fetch, EventSource, CSS, location, setTimeout, clearTimeout */
// Live run page. Subscribes to the run's event stream and patches the page in place: progress on
// every finished pair, the verdict, proof strip and checks table on every hub summary, the ledger
// from the fragments endpoint. When the run ends the page reloads once into its static form.
const script =
  document.currentScript || document.querySelector("script[data-run]");
const key = script.dataset.run;
const since = Number(script.dataset.since || 0);
const [suite, run] = key.split("/");
const base = `/r/${encodeURIComponent(suite)}/${encodeURIComponent(run)}`;
const api = `/api/runs/${encodeURIComponent(suite)}/${encodeURIComponent(run)}`;
const TERMINAL = new Set(["finished", "failed", "cancelled", "lost"]);

const $ = (s) => document.querySelector(s);
const put = (sel, html) => {
  const el = $(sel);
  if (el && typeof html === "string") el.innerHTML = html;
};

let total = 0;
let finished = 0;
let ended = false;

function progress() {
  const p = $("[data-progress]");
  if (p) p.textContent = total ? `${finished} of ${total} pairs` : "";
  const b = $("[data-progress-bar]");
  if (b)
    b.style.width = total ? `${Math.round((100 * finished) / total)}%` : "0%";
}

function status(s) {
  const el = $("[data-status]");
  if (!el) return;
  el.className = `status ${s}`;
  el.lastChild.textContent = s;
}

let fragmentTimer = 0;
function refreshFragments() {
  clearTimeout(fragmentTimer);
  fragmentTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${base}/fragments`, {
        headers: { accept: "application/json" },
      });
      if (!r.ok) return;
      const f = await r.json();
      put('[data-section="headline"]', f.headline);
      put('[data-section="lede"]', f.lede);
      put('[data-section="verdict"]', f.verdict);
      put('[data-section="proof"]', f.proof);
      put('[data-section="checks"]', f.checks);
      put('[data-section="ledger"]', f.ledger);
    } catch {
      /* the next event tries again */
    }
  }, 400);
}

function flash(line) {
  const row = document.querySelector(
    `tr[data-case="${CSS.escape(line.case_id)}"]`,
  );
  if (row) {
    row.classList.remove("live-new");
    void row.offsetWidth;
    row.classList.add("live-new");
  }
}

const es = new EventSource(`${api}/events?since=${since}`);
es.addEventListener("run_start", (e) => {
  const d = JSON.parse(e.data);
  total = d.total + d.resumed;
  finished = d.resumed;
  progress();
  status("running");
  refreshFragments();
});
es.addEventListener("job_done", (e) => {
  const d = JSON.parse(e.data);
  finished = d.finished + Math.max(0, total - d.total);
  progress();
  flash(d.line);
});
es.addEventListener("summary", (e) => {
  const d = JSON.parse(e.data);
  if (d.html) {
    put('[data-section="verdict"]', d.html.verdict);
    put('[data-section="proof"]', d.html.proof);
  }
  refreshFragments();
});
es.addEventListener("status", (e) => {
  const d = JSON.parse(e.data);
  status(d.status);
  if (TERMINAL.has(d.status)) finish();
});
es.addEventListener("end", finish);
es.onerror = () => {
  /* EventSource reconnects on its own with Last-Event-ID */
};

function finish() {
  if (ended) return;
  ended = true;
  es.close();
  setTimeout(() => location.reload(), 600);
}
