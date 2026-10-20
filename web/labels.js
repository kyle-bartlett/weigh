/* global document, fetch, window */
// Labels page: one case at a time, hotkeys, every label saved to the hub as it is given.
const raw = document.getElementById("labels-data");
const data = JSON.parse(
  raw.textContent
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"),
);
const root = document.querySelector("[data-labels-app]");
const api = `/api/runs/${encodeURIComponent(data.suite)}/${encodeURIComponent(data.run_id)}/labels`;
const labels = new Map(data.labels.map((l) => [l.case_id, l]));
let i = Math.max(
  0,
  data.cases.findIndex((c) => !labels.has(c.id)),
);
if (i < 0) i = 0;

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const checks = (line) =>
  data.checks
    .map((k) => {
      const v = line?.checks?.[k];
      const state =
        v === undefined
          ? line?.unanswered?.includes(k)
            ? "unanswered"
            : "n/a"
          : v
            ? "pass"
            : "fail";
      return `<tr><td class="mono">${esc(k)}</td><td><span class="tag ${state === "pass" ? "green" : state === "fail" ? "amber" : ""}">${state}</span></td></tr>`;
    })
    .join("");
const outputOf = (line) =>
  line
    ? line.ok
      ? esc(JSON.stringify(line.extra ?? {}, null, 1))
      : esc(line.error ?? "error")
    : "no output";

function render() {
  if (!data.cases.length) return;
  const c = data.cases[i];
  const l = labels.get(c.id);
  const cand = c.lines[data.candidate];
  const base = c.lines[data.baseline];
  root.innerHTML = `<div class="row" style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin:0 0 14px">
<span class="mono">${i + 1} / ${data.cases.length} · <b>${esc(c.id)}</b></span>
<span>${l ? `<span class="tag ${l.human === "pass" ? "green" : "amber"}">${l.human}</span> ${l.split ? `<span class="tag">${esc(l.split)}</span>` : ""}` : '<span class="tag">unlabelled</span>'}</span>
<span><button class="btn" data-act="pass">pass (p)</button> <button class="btn" data-act="fail">fail (f)</button> <button class="btn" data-act="clear">clear</button> <select class="txt" style="min-width:0" data-split><option value="">split</option>${data.splits.map((s) => `<option ${l?.split === s ? "selected" : ""}>${s}</option>`).join("")}</select> <button class="btn" data-act="back">back (b)</button> <button class="btn primary" data-act="next">next (n)</button></span></div>
<pre class="out" style="max-height:32vh">${esc(c.input)}</pre>
<div class="two" style="grid-template-columns:1fr 1fr;margin-top:16px">
<div><h3 class="mono">${esc(data.candidate)} (candidate)</h3><table><tbody>${checks(cand)}</tbody></table><pre class="out" style="max-height:28vh">${outputOf(cand)}</pre></div>
<div><h3 class="mono">${esc(data.baseline)} (baseline)</h3><table><tbody>${checks(base)}</tbody></table><pre class="out" style="max-height:28vh">${outputOf(base)}</pre></div></div>
<p style="margin-top:14px"><input class="txt" id="note" style="width:100%" placeholder="note (/ to focus, Esc to leave)" value="${esc(l?.note ?? "")}"></p>`;
  const done = data.cases.filter((x) => labels.has(x.id)).length;
  const p = document.querySelector("[data-progress]");
  if (p) p.textContent = `${done} of ${data.cases.length}`;
}

async function save(human) {
  const c = data.cases[i];
  const row = {
    case_id: c.id,
    variant: data.candidate,
    human,
    note: document.getElementById("note")?.value ?? "",
    split: document.querySelector("[data-split]")?.value || undefined,
  };
  labels.set(c.id, row);
  render();
  const r = await fetch(api, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels: [row] }),
  });
  if (!r.ok) window.alert(`save failed: ${r.status}`);
}

async function clear() {
  const c = data.cases[i];
  labels.delete(c.id);
  render();
  await fetch(
    `${api}/${encodeURIComponent(c.id)}/${encodeURIComponent(data.candidate)}`,
    { method: "DELETE" },
  );
}

const go = (d) => {
  i = Math.min(data.cases.length - 1, Math.max(0, i + d));
  render();
};

root.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "pass" || act === "fail") save(act);
  else if (act === "clear") clear();
  else if (act === "next") go(1);
  else if (act === "back") go(-1);
});
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "p") save("pass");
  else if (e.key === "f") save("fail");
  else if (e.key === "n" || e.key === "ArrowRight") go(1);
  else if (e.key === "b" || e.key === "ArrowLeft") go(-1);
  else if (e.key === "/") {
    e.preventDefault();
    document.getElementById("note")?.focus();
  }
});
render();
