import crypto from "node:crypto";
import type { FileItem, Item, TextItem } from "../shared/types";

export interface HistoryStoreOptions {
  maxItems: number;
  maxTotalFileBytes: number;
  /** Called with the id of any item evicted to honour a cap, so the caller
   *  can broadcast `item:deleted` and keep clients in sync. */
  onEvicted?: (id: string) => void;
}

/**
 * In-memory history: a single ordered list (newest first) capped by count and
 * by total blob bytes. Evicting an item also frees its blob.
 */
export class HistoryStore {
  private items: Item[] = [];
  private blobs = new Map<string, Buffer>();
  private totalFileBytes = 0;
  private readonly maxItems: number;
  private readonly maxTotalFileBytes: number;
  private readonly onEvicted?: (id: string) => void;

  constructor(opts: HistoryStoreOptions) {
    this.maxItems = opts.maxItems;
    this.maxTotalFileBytes = opts.maxTotalFileBytes;
    this.onEvicted = opts.onEvicted;
  }

  /** Snapshot of history, newest first. */
  getHistory(): Item[] {
    return this.items.slice();
  }

  addText(html: string): TextItem {
    const item: TextItem = {
      id: crypto.randomUUID(),
      kind: "text",
      html,
      createdAt: Date.now(),
    };
    this.items.unshift(item);
    this.enforceCaps();
    return item;
  }

  addFile(name: string, mime: string, buffer: Buffer): FileItem {
    const item: FileItem = {
      id: crypto.randomUUID(),
      kind: "file",
      name,
      size: buffer.length,
      mime,
      createdAt: Date.now(),
    };
    this.items.unshift(item);
    this.blobs.set(item.id, buffer);
    this.totalFileBytes += buffer.length;
    this.enforceCaps();
    return item;
  }

  getBlob(id: string): Buffer | undefined {
    return this.blobs.get(id);
  }

  getItem(id: string): Item | undefined {
    return this.items.find((item) => item.id === id);
  }

  has(id: string): boolean {
    return this.items.some((item) => item.id === id);
  }

  /** Remove an item and free its blob. Returns true if it existed. */
  delete(id: string): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.removeAt(index);
    return true;
  }

  private removeAt(index: number): void {
    const [item] = this.items.splice(index, 1);
    if (item && item.kind === "file") {
      const blob = this.blobs.get(item.id);
      if (blob) {
        this.totalFileBytes -= blob.length;
        this.blobs.delete(item.id);
      }
    }
  }

  private enforceCaps(): void {
    // Count cap: drop oldest (end of list) beyond maxItems.
    while (this.items.length > this.maxItems) {
      const evicted = this.items[this.items.length - 1];
      this.removeAt(this.items.length - 1);
      this.onEvicted?.(evicted.id);
    }
    // Total blob bytes cap: evict oldest file items until under the limit.
    while (this.totalFileBytes > this.maxTotalFileBytes) {
      const index = this.findOldestFileIndex();
      if (index === -1) break;
      const evicted = this.items[index];
      this.removeAt(index);
      this.onEvicted?.(evicted.id);
    }
  }

  private findOldestFileIndex(): number {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].kind === "file") return i;
    }
    return -1;
  }
}
