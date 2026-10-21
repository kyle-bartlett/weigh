/* global document, window, localStorage, matchMedia, HTMLElement, requestAnimationFrame, cancelAnimationFrame */
const key = "weigh.tour.v1";
const steps = [
  {
    anchor: ".verdict-card",
    title: "Start with the verdict",
    copy: "See which prompt did better on the same cases and whether it cleared the shipping rules.",
  },
  {
    anchor: '[data-section="changed"] section',
    title: "See what changed",
    copy: "These cases gained or lost a passing check. Open one to see the evidence.",
  },
  {
    anchor: '[data-section="ledger"] tr[data-case]',
    title: "Read a case",
    copy: "Each row compares the current and new prompts. Open the case to see the input, checks and saved outputs.",
  },
  {
    anchor: "#engineers > summary",
    title: "Go deeper",
    copy: "Open For engineers for the full measurements, grading method and links to reproduce this comparison.",
  },
];
let started = false;

function start() {
  if (started || !document.querySelector('[data-share][data-finished="true"]'))
    return;
  try {
    if (localStorage.getItem(key)) return;
  } catch {
    /* The tour still works when storage is disabled. */
  }
  const available = steps.filter((step) => document.querySelector(step.anchor));
  if (!available.length) return;
  started = true;
  try {
    localStorage.setItem(key, "seen");
  } catch {
    /* Remember for this page lifetime instead. */
  }
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "tour-tooltip";
  dialog.setAttribute("aria-labelledby", "tour-title");
  dialog.setAttribute("aria-describedby", "tour-copy");
  dialog.innerHTML = `<p class="mono tour-progress"></p><h2 id="tour-title" tabindex="-1"></h2><p id="tour-copy"></p><div class="tour-actions"><button class="btn" type="button" data-back>Back</button><button class="btn" type="button" data-skip>Skip</button><button class="btn primary" type="button" data-next>Next</button></div>`;
  document.body.append(dialog);
  const title = dialog.querySelector("h2");
  const back = dialog.querySelector("[data-back]");
  const next = dialog.querySelector("[data-next]");
  let index = 0;
  let anchor;
  let frame = 0;

  function position() {
    if (!anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const box = dialog.getBoundingClientRect();
    const below = rect.bottom + 12;
    const top =
      below + box.height <= height - 12 ? below : rect.top - box.height - 12;
    dialog.style.left = `${Math.max(12, Math.min(rect.left, width - box.width - 12))}px`;
    dialog.style.top = `${Math.max(12, Math.min(top, height - box.height - 12))}px`;
  }
  function schedulePosition() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(position);
  }
  function close() {
    cancelAnimationFrame(frame);
    anchor?.classList.remove("tour-target");
    window.removeEventListener("resize", schedulePosition);
    window.removeEventListener("scroll", schedulePosition, true);
    dialog.close();
    dialog.remove();
    if (previous instanceof HTMLElement && previous.isConnected)
      previous.focus({ preventScroll: true });
  }
  function show(direction = 1) {
    anchor?.classList.remove("tour-target");
    while (index >= 0 && index < available.length) {
      anchor = document.querySelector(available[index].anchor);
      if (anchor) break;
      index += direction;
    }
    if (!anchor || index < 0 || index >= available.length) {
      close();
      return;
    }
    const step = available[index];
    dialog.querySelector(".tour-progress").textContent =
      `Step ${index + 1} of ${available.length} · About 60 seconds`;
    title.textContent = step.title;
    dialog.querySelector("#tour-copy").textContent = step.copy;
    back.disabled = index === 0;
    next.textContent = index === available.length - 1 ? "Done" : "Next";
    anchor.classList.add("tour-target");
    anchor.scrollIntoView({
      block: "center",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    if (!dialog.open) dialog.showModal();
    title.focus({ preventScroll: true });
    position();
  }
  back.addEventListener("click", () => {
    index--;
    show(-1);
  });
  next.addEventListener("click", () => {
    if (index === available.length - 1) close();
    else {
      index++;
      show();
    }
  });
  dialog.querySelector("[data-skip]").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, true);
  show();
}

document.addEventListener("weigh:run-finished", start);
start();
