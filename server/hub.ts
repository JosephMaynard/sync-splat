import type { Item } from "../shared/types";
import type { SyncSplatIO } from "./socket";

/** A history change, as fanned out to non-socket subscribers (SSE streams). */
export type HubEvent =
  | { name: "item:new"; item: Item }
  | { name: "item:deleted"; id: string };

/**
 * The single broadcast path for history changes. Items are created and
 * removed from several places (socket text:send / item:delete, HTTP uploads
 * and /api/text, store eviction); every one of them goes through here so
 * socket.io clients and terminal event streams can never drift apart.
 */
export interface BroadcastHub {
  itemNew(item: Item): void;
  itemDeleted(id: string): void;
  /** Receive every history change. Returns an unsubscribe function. */
  subscribe(listener: (event: HubEvent) => void): () => void;
}

export function createBroadcastHub(io: SyncSplatIO): BroadcastHub {
  const listeners = new Set<(event: HubEvent) => void>();

  function fanOut(event: HubEvent): void {
    // Copy first: a listener may unsubscribe mid-dispatch (a stream that is
    // over its buffer cap destroys itself). One misbehaving listener must not
    // starve the rest, so each runs in isolation.
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch {
        // Nothing useful to do; the listener's own close path cleans it up.
      }
    }
  }

  return {
    itemNew(item) {
      io.emit("item:new", item);
      fanOut({ name: "item:new", item });
    },
    itemDeleted(id) {
      io.emit("item:deleted", id);
      fanOut({ name: "item:deleted", id });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
