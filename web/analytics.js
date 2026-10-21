/* global document, window, IntersectionObserver */
// Loaded after the optional tracker. Missing or blocked analytics never gates the UI.
const track = (event) => window.staats?.(event);
if (document.querySelector(".case-page")) track("case_opened");

// The wrapper survives streaming replacements of the verdict card.
const verdict = document.querySelector('.run-page [data-section="verdict"]');
if (verdict && typeof IntersectionObserver !== "undefined") {
  let viewed = false;
  const observer = new IntersectionObserver((entries) => {
    if (viewed || !entries.some((entry) => entry.isIntersecting)) return;
    viewed = true;
    track("verdict_viewed");
    observer.disconnect();
  });
  observer.observe(verdict);
}

document.addEventListener(
  "toggle",
  ({ target }) => {
    if (!target.open) return;
    // Restoring an already open case after a live update isn't another reader action.
    if (target.dataset?.analyticsRestored !== undefined) {
      delete target.dataset.analyticsRestored;
      return;
    }
    if (target.id === "engineers") track("engineers_opened");
    else if (target.matches?.("tr[data-case] details")) track("case_opened");
  },
  true,
);

document.addEventListener("click", ({ target }) => {
  if (target.closest?.("[data-copy-summary]")) track("copy_summary");
});
