import { describe, expect, it } from "vitest";
import { HistoryStore } from "./store";

describe("HistoryStore", () => {
  it("evicts the oldest item once the count cap is exceeded and calls onEvicted", () => {
    const evicted: string[] = [];
    const store = new HistoryStore({
      maxItems: 3,
      maxTotalFileBytes: 1024 * 1024,
      onEvicted: (id) => evicted.push(id),
    });

    const first = store.addText("first");
    store.addText("second");
    store.addText("third");
    expect(evicted).toEqual([]);
    expect(store.getHistory()).toHaveLength(3);

    // Fourth item pushes count over the cap; the oldest (first) is evicted.
    store.addText("fourth");
    expect(evicted).toEqual([first.id]);
    expect(store.getHistory()).toHaveLength(3);
    expect(store.has(first.id)).toBe(false);
  });

  it("frees the blob of a count-evicted file item", () => {
    const evicted: string[] = [];
    const store = new HistoryStore({
      maxItems: 1,
      maxTotalFileBytes: 1024 * 1024,
      onEvicted: (id) => evicted.push(id),
    });

    const first = store.addFile("a.bin", "application/octet-stream", Buffer.from("hello"));
    expect(store.getBlob(first.id)).toBeDefined();

    store.addFile("b.bin", "application/octet-stream", Buffer.from("world"));

    expect(evicted).toEqual([first.id]);
    expect(store.getBlob(first.id)).toBeUndefined();
    expect(store.has(first.id)).toBe(false);
  });

  it("evicts oldest FILE items first when the byte cap is exceeded, leaving text items intact", () => {
    const evicted: string[] = [];
    const store = new HistoryStore({
      maxItems: 100,
      maxTotalFileBytes: 10,
      onEvicted: (id) => evicted.push(id),
    });

    const oldFile = store.addFile("old.bin", "application/octet-stream", Buffer.alloc(6, 1));
    const text = store.addText("keep me");
    // Pushes totalFileBytes to 12 > 10, so the oldest file (oldFile) must go.
    const newFile = store.addFile("new.bin", "application/octet-stream", Buffer.alloc(6, 2));

    expect(evicted).toEqual([oldFile.id]);
    expect(store.has(oldFile.id)).toBe(false);
    expect(store.has(text.id)).toBe(true);
    expect(store.has(newFile.id)).toBe(true);
    expect(store.getBlob(newFile.id)?.length).toBe(6);
  });

  it("delete() returns false for an unknown id and true for a known id", () => {
    const store = new HistoryStore({ maxItems: 10, maxTotalFileBytes: 1024 });
    expect(store.delete("does-not-exist")).toBe(false);

    const item = store.addText("hi");
    expect(store.delete(item.id)).toBe(true);
    expect(store.delete(item.id)).toBe(false);
  });

  it("keeps totals consistent after mixed add/delete operations", () => {
    const store = new HistoryStore({ maxItems: 100, maxTotalFileBytes: 1024 * 1024 });

    const t1 = store.addText("one");
    const f1 = store.addFile("f1.bin", "application/octet-stream", Buffer.alloc(100));
    const f2 = store.addFile("f2.bin", "application/octet-stream", Buffer.alloc(200));
    const t2 = store.addText("two");

    expect(store.getHistory()).toHaveLength(4);

    store.delete(f1.id);
    expect(store.getBlob(f1.id)).toBeUndefined();
    expect(store.getHistory()).toHaveLength(3);

    // Deleting a text item shouldn't touch blob accounting.
    store.delete(t1.id);
    expect(store.getHistory()).toHaveLength(2);
    expect(store.getBlob(f2.id)?.length).toBe(200);

    // Adding a large file afterwards should only be capped by the
    // remaining budget, confirming totalFileBytes tracked f1's removal.
    const f3 = store.addFile(
      "f3.bin",
      "application/octet-stream",
      Buffer.alloc(1024 * 1024 - 200 - 1),
    );
    expect(store.has(f2.id)).toBe(true);
    expect(store.has(f3.id)).toBe(true);
    expect(store.has(t2.id)).toBe(true);
  });

  it("getHistory returns items newest first", () => {
    const store = new HistoryStore({ maxItems: 10, maxTotalFileBytes: 1024 });
    const a = store.addText("a");
    const b = store.addText("b");
    const history = store.getHistory();
    expect(history[0].id).toBe(b.id);
    expect(history[1].id).toBe(a.id);
  });

  it("getHistory returns a snapshot, not a live view", () => {
    const store = new HistoryStore({ maxItems: 10, maxTotalFileBytes: 1024 });
    store.addText("a");
    const snapshot = store.getHistory();
    store.addText("b");
    expect(snapshot).toHaveLength(1);
  });
});
