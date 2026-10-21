import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("label progress follows pass, fail and clear without counting navigation", () => {
  const data = {
    suite: "example",
    run_id: "run",
    candidate: "new",
    baseline: "old",
    checks: [],
    splits: [],
    labels: [],
    cases: [
      { id: "first", input: "", lines: {} },
      { id: "second", input: "", lines: {} },
    ],
  };
  const text = { textContent: "" };
  const bar = {
    value: 0,
    setAttribute: (_: string, value: string) => {
      text.textContent = value;
    },
  };
  let click: (event: any) => void = () => {};
  const root = {
    innerHTML: "",
    addEventListener: (_: string, fn: typeof click) => {
      click = fn;
    },
  };
  runInNewContext(
    readFileSync(new URL("../web/labels.js", import.meta.url), "utf8"),
    {
      document: {
        getElementById: (id: string) =>
          id === "labels-data" ? { textContent: JSON.stringify(data) } : null,
        querySelector: (selector: string) =>
          new Map<string, unknown>([
            ["[data-labels-app]", root],
            ["[data-progress]", text],
            ["[data-label-progress]", bar],
          ]).get(selector),
        addEventListener() {},
      },
      fetch: async () => ({ ok: true }),
      window: { alert() {} },
    },
  );
  const act = (action: string) =>
    click({ target: { closest: () => ({ dataset: { act: action } }) } });
  act("pass");
  expect(bar.value).toBe(1);
  expect(text.textContent).toBe("1 of 2 labelled");
  act("next");
  expect(bar.value).toBe(1);
  act("fail");
  expect(bar.value).toBe(2);
  act("clear");
  expect(bar.value).toBe(1);
});
