import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { esc } from "../report/html.ts";
import { plainSummary, type VerdictSummary } from "./share.ts";

export const ogFontFiles = [
  "BricolageGrotesque-Variable.ttf",
  "InstrumentSans-Variable.ttf",
  "IBMPlexMono-Regular.ttf",
].map((file) => join(import.meta.dir, "../../web/fonts", file));

// Conservative wrapping also splits unbroken version names. Every block has a fixed line budget.
function lines(text: string, columns: number, limit: number): string[] {
  const words = plainSummary(text)
    .split(" ")
    .flatMap((word) => {
      const chunks: string[] = [];
      const chars = Array.from(word);
      while (chars.length) chunks.push(chars.splice(0, columns).join(""));
      return chunks;
    });
  const rows: string[] = [];
  let row = "";
  for (const word of words) {
    if (row && Array.from(`${row} ${word}`).length > columns) {
      rows.push(row);
      row = "";
    }
    row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  if (rows.length > limit)
    rows[limit - 1] = rows[limit - 1]!.replace(/\s+\S*$/, "") + "…";
  return rows.slice(0, limit);
}

/** Pure summary-to-SVG seam shared by the route and the close-out image probe. */
export function verdictSvg(summary: VerdictSummary): string {
  const color = summary.ship === "Ship it" ? "#157A52" : "#B8731B";
  const text = (
    value: string,
    y: number,
    size: number,
    maxLines: number,
    family = "Instrument Sans",
    fill = "#131A16",
  ) =>
    `<text x="64" y="${y}" font-family="${family}" font-size="${size}" fill="${fill}">${lines(
      value,
      Math.floor(1072 / (size * 0.72)),
      maxLines,
    )
      .map(
        (line, i) =>
          `<tspan x="64" dy="${i ? size * 1.2 : 0}">${esc(line)}</tspan>`,
      )
      .join("")}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#F2F4F1"/>
<rect x="32" y="32" width="1136" height="566" rx="6" fill="#FAFBF9" stroke="#CBD2CD"/>
${text("Weigh", 86, 30, 1, "Bricolage Grotesque")}
<text x="1136" y="82" text-anchor="end" font-family="IBM Plex Mono" font-size="17" fill="#4B554F">${summary.status === "finished" ? "RUN VERDICT" : ["failed", "cancelled", "lost"].includes(summary.status) ? "RUN INCOMPLETE" : "Still running"}</text>
${text(summary.sentence, 150, 44, 4, "Bricolage Grotesque")}
${text(summary.ship, 378, 32, 1, "Bricolage Grotesque", color)}
<path d="M64 404H1136" stroke="#CBD2CD"/>
${text(summary.changed, 444, 24, 2)}
${text(summary.answers, 529, 22, 1, "Instrument Sans", "#4B554F")}
${text(summary.cost, 565, 22, 1, "Instrument Sans", "#4B554F")}
</svg>`;
}

export function renderVerdictPng(summary: VerdictSummary): Uint8Array {
  return new Resvg(verdictSvg(summary), {
    font: { loadSystemFonts: false, fontFiles: ogFontFiles },
  })
    .render()
    .asPng();
}
