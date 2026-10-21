import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../web/tour.js", import.meta.url), "utf8");

function visit(hash: string, storage: Map<string, string>, width = 1000) {
  const callbacks = new Map<string, () => void>();
  const scrollBy = mock(() => {});
  const anchor = {
    isConnected: true,
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({
      top: 450,
      bottom: 550,
      left: 20,
      height: 100,
    }),
    scrollIntoView: mock(() => {}),
  };
  const element = { focus() {}, addEventListener() {} };
  const dialog = {
    open: false,
    style: { left: "", top: "" },
    setAttribute() {},
    querySelector: () => ({ ...element }),
    addEventListener() {},
    getBoundingClientRect: () => ({ width: 360, height: 250 }),
    showModal: mock(function () {
      dialog.open = true;
    }),
    close() {},
    remove() {},
  };
  const body = { style: { paddingBottom: "" }, append: mock(() => {}) };
  const getItem = mock((key: string) => storage.get(key));
  const setItem = mock((key: string, value: string) => {
    storage.set(key, value);
  });
  runInNewContext(script, {
    document: {
      body,
      documentElement: { clientWidth: width },
      querySelector: () => anchor,
      createElement: () => dialog,
      addEventListener: (name: string, fn: () => void) =>
        callbacks.set(name, fn),
    },
    window: {
      location: { hash },
      innerHeight: 844,
      getComputedStyle: () => ({ paddingBottom: "0px" }),
      scrollBy,
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: { getItem, setItem },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  return { dialog, body, callbacks, getItem, setItem, scrollBy, anchor };
}

test("fragment visits leave first-visit storage untouched, including live completion; a later plain visit starts", () => {
  const storage = new Map<string, string>();
  const linked = visit("#engineers", storage);
  linked.callbacks.get("weigh:run-finished")!();
  expect(linked.dialog.showModal).not.toHaveBeenCalled();
  expect(linked.getItem).not.toHaveBeenCalled();
  expect(linked.setItem).not.toHaveBeenCalled();
  expect(storage.size).toBe(0);
  const plain = visit("", storage);
  expect(plain.dialog.showModal).toHaveBeenCalledTimes(1);
  expect(plain.setItem).toHaveBeenCalledWith("weigh.tour.v1", "seen");
  expect(visit("", storage).dialog.showModal).not.toHaveBeenCalled();
});

test("phone tour scrolls its anchor above the sheet, while desktop keeps anchored positioning", () => {
  for (const width of [390, 640]) {
    const phone = visit("", new Map(), width);
    expect(phone.dialog.style).toEqual({ left: "0px", top: "auto" });
    expect(phone.body.style.paddingBottom).toBe("274px");
    expect(phone.anchor.scrollIntoView).not.toHaveBeenCalled();
    expect(phone.scrollBy).toHaveBeenCalledWith({
      top: 203,
      behavior: "instant",
    });
  }
  const desktop = visit("", new Map(), 641);
  expect(desktop.dialog.style).toEqual({ left: "20px", top: "562px" });
  expect(desktop.anchor.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(desktop.scrollBy).not.toHaveBeenCalled();
  expect(desktop.body.style.paddingBottom).toBe("");
});
