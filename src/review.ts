import { readOutput } from "./run.ts";
import { CSS, esc } from "./report/html.ts";
import type { RunMeta, TraceLine } from "./types.ts";

/**
 * The review page: one case at a time, both variants side by side, the checks, hotkeys, notes.
 * Labels live in the browser (localStorage) until "Export" writes labels.jsonl. This is where the
 * first 30 cases get open-coded by a person before any judge is built.
 */

export interface ReviewInput {
  dir: string;
  meta: RunMeta & { case_order: string[] };
  lines: TraceLine[];
  baseline: string;
  candidate: string;
  /** Short text shown as the case input (the runner saves it in inputs.json). */
  inputText?: (caseId: string) => string;
}

const EXTRA_CSS = `
.review{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;margin-top:20px}
.col{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px 16px;min-width:0}
.col h3{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.out{font-family:"IBM Plex Mono",monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto;background:var(--bg2);padding:10px 12px;border-radius:4px;border:1px solid var(--line2)}
.input{font-size:14px;color:var(--ink2);white-space:pre-wrap;max-height:22vh;overflow:auto;padding:10px 12px;border:1px solid var(--line2);border-radius:4px;background:var(--card)}
.nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px}
button{font:inherit;font-size:13px;padding:7px 12px;border:1px solid var(--line);border-radius:3px;background:var(--card);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--ink)}button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.progress{height:5px;background:var(--bg2);border-radius:3px;overflow:hidden;margin:14px 0 6px}.progress i{display:block;height:100%;background:var(--live)}
textarea{width:100%;min-height:72px;font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink)}
.lbl{font-weight:600}.lbl.pass{color:var(--live)}.lbl.fail{color:var(--gate)}
kbd{font-family:"IBM Plex Mono",monospace;font-size:11.5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:3px;padding:1px 5px;background:var(--bg2)}
@media (max-width:900px){.review{grid-template-columns:1fr}}
`;

export function renderReview(r: ReviewInput): string {
  const byVar = (v: string) =>
    new Map(r.lines.filter((l) => l.variant === v).map((l) => [l.case_id, l]));
  const bl = byVar(r.baseline),
    cl = byVar(r.candidate);
  const checkIds = r.meta.checks.map((c) => c.id);
  const cases = r.meta.case_order
    .filter((id) => bl.has(id) || cl.has(id))
    .map((id) => {
      const b = bl.get(id),
        c = cl.get(id);
      const ob = b ? readOutput(r.dir, b) : undefined,
        oc = c ? readOutput(r.dir, c) : undefined;
      return {
        id,
        input: r.inputText ? r.inputText(id) : "",
        b: b
          ? {
              ok: b.ok,
              error: b.error,
              checks: b.checks,
              usage: b.usage,
              extra: b.extra,
              output: ob?.output,
            }
          : null,
        c: c
          ? {
              ok: c.ok,
              error: c.error,
              checks: c.checks,
              usage: c.usage,
              extra: c.extra,
              output: oc?.output,
            }
          : null,
      };
    });
  const data = JSON.stringify({
    suite: r.meta.suite,
    run: r.meta.run_id,
    baseline: r.baseline,
    candidate: r.candidate,
    checkIds,
    cases,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weigh review: ${esc(r.meta.suite)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"><style>${CSS}${EXTRA_CSS}</style></head><body><div class="wrap">
<div class="top"><div><span class="name">Weigh review</span> <span class="meta">${esc(r.meta.suite)} · run ${esc(r.meta.run_id)}</span></div><div class="meta"><kbd>p</kbd> pass <kbd>f</kbd> fail <kbd>n</kbd> next <kbd>b</kbd> back <kbd>/</kbd> notes · labels stay in this browser until you export</div></div>
<div class="progress"><i id="bar" style="width:0%"></i></div>
<div class="label" id="pos"></div>
<h2 class="display mono" id="cid" style="font-size:26px;margin-top:6px"></h2>
<div class="input" id="input"></div>
<div class="review">
<div class="col"><h3><span>${esc(r.baseline)}</span><span class="label" id="bmeta"></span></h3><div id="bchecks"></div><div class="out" id="bout"></div></div>
<div class="col"><h3><span>${esc(r.candidate)}</span><span class="label" id="cmeta"></span></h3><div id="cchecks"></div><div class="out" id="cout"></div></div>
</div>
<div class="nav"><span>Your label for <b>${esc(r.candidate)}</b> on this case: <span class="lbl" id="lbl">none</span></span><button onclick="label('pass')">Pass (p)</button><button onclick="label('fail')">Fail (f)</button><button onclick="go(-1)">Back (b)</button><button onclick="go(1)">Next (n)</button><button class="primary" onclick="exportLabels()">Export labels.jsonl</button><span class="meta" id="count"></span></div>
<textarea id="note" placeholder="What went wrong, in your words. First upstream failure, not why."></textarea>
<p class="notes" style="font-size:13px;color:var(--ink3);margin-top:14px">Open coding: write what you see, not a rubric. After about 30 cases, group the notes into failure modes; only then decide which deserve a code check or a judge.</p>
</div>
<script>
const D=${data};
const KEY='weigh:'+D.suite+':'+D.run;
let i=0;const store=JSON.parse(localStorage.getItem(KEY)||'{}');
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const dots=(l)=>D.checkIds.map(k=>'<span class="chk '+(l.checks[k]===undefined?'na':l.checks[k]?'':'fail')+'" title="'+k+'"></span><span style="font-size:12px;color:var(--ink2);margin-right:10px">'+k+'</span>').join('');
const tok=u=>u?(u.inputTokens+u.cacheReadTokens+u.cacheCreationTokens).toLocaleString()+' prompt tok':'';
function show(){const c=D.cases[i];$('pos').textContent='case '+(i+1)+' of '+D.cases.length;$('cid').textContent=c.id;$('input').textContent=c.input||'(input shown in the suite data directory)';
for(const [side,v] of [['b',c.b],['c',c.c]]){if(!v){$(side+'out').textContent='(not run)';$(side+'checks').innerHTML='';$(side+'meta').textContent='';continue;}
$(side+'meta').textContent=tok(v.usage)+(v.extra?'  '+Object.entries(v.extra).map(([k,x])=>k+'='+x).join(' '):'');$(side+'checks').innerHTML=dots(v);$(side+'out').textContent=v.ok?JSON.stringify(v.output,null,1):'ERROR: '+v.error;}
const s=store[c.id]||{};$('lbl').textContent=s.human||'none';$('lbl').className='lbl '+(s.human||'');$('note').value=s.note||'';$('bar').style.width=(100*Object.keys(store).length/D.cases.length)+'%';$('count').textContent=Object.keys(store).length+' labeled';}
function save(){const c=D.cases[i];store[c.id]={...(store[c.id]||{}),note:$('note').value};localStorage.setItem(KEY,JSON.stringify(store));}
function label(h){const c=D.cases[i];store[c.id]={human:h,note:$('note').value};localStorage.setItem(KEY,JSON.stringify(store));show();}
function go(d){save();i=Math.max(0,Math.min(D.cases.length-1,i+d));show();}
function exportLabels(){save();const lines=Object.entries(store).filter(([,v])=>v.human).map(([id,v])=>JSON.stringify({case_id:id,variant:D.candidate,human:v.human,note:v.note||''}));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\\n')+'\\n'],{type:'application/jsonl'}));a.download='labels-'+D.suite+'-'+D.run+'.jsonl';a.click();}
document.addEventListener('keydown',e=>{if(e.target.tagName==='TEXTAREA'){if(e.key==='Escape')e.target.blur();return;}if(e.key==='p')label('pass');else if(e.key==='f')label('fail');else if(e.key==='n'||e.key==='ArrowRight')go(1);else if(e.key==='b'||e.key==='ArrowLeft')go(-1);else if(e.key==='/'){e.preventDefault();$('note').focus();}});
$('note').addEventListener('blur',save);show();
</script></body></html>`;
}
