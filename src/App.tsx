import { useEffect, useRef, useState } from "react";
import { socket, sendUpdate } from "./socket";
import type { HistoryItemData } from "./types";
import HistoryItem from "./HistoryItem";
import Logo from "./Logo";

export default function App() {
  const clipRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<HistoryItemData[]>([]);

  /* socket lifecycle */
  useEffect(() => {
    const handleHistory = (list: HistoryItemData[]) => setHistory(list);
    const handleUpdate = (item: HistoryItemData) =>
      setHistory((prev) => [item, ...prev.slice(0, 19)]);

    socket.on("history", handleHistory);
    socket.on("update", handleUpdate);

    return () => {
      socket.off("history", handleHistory);
      socket.off("update", handleUpdate);
    };
  }, []);

  /* broadcast current editor content */
  const broadcast = () => {
    if (!clipRef.current) return;
    const html = clipRef.current.innerHTML;
    sendUpdate({ type: "html", data: html });
  };

  return (
    <div className="flex h-screen p-6 gap-6 bg-gray-100">
      {/* left column */}
      <div className="flex-1 flex flex-col">
        <header className="flex items-center gap-2 mb-4">
          <Logo className="w-8 h-8" />
          <h1 className="text-3xl font-bold">Sync Splat</h1>
        </header>

        <div
          ref={clipRef}
          contentEditable
          className="flex-1 border rounded bg-white p-4 overflow-auto"
        />
        <button
          onClick={broadcast}
          className="mt-4 self-start bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Broadcast
        </button>
      </div>

      {/* right column – history */}
      <aside className="w-1/3 space-y-2 overflow-y-auto">
        {history.map((item, i) => (
          <HistoryItem
            key={i}
            item={item}
            onDelete={() =>
              setHistory((h) => h.filter((_, idx) => idx !== i))
            }
          />
        ))}
      </aside>
    </div>
  );
}