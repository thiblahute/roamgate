import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type CompanionMemoryFile,
  deleteCompanionMemory,
  listCompanionMemories,
} from "../companionMemory";
import { store } from "../store";

/** How long the second click may come after the first. */
const DELETE_CONFIRM_MS = 4000;

function day(at: number): string {
  return new Date(at).toLocaleDateString();
}

function MemoryRow({
  memory,
  onDeleted,
}: {
  memory: CompanionMemoryFile;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), DELETE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <li className="companion-panel-memory">
      <details>
        <summary>
          <span className="companion-panel-memory-name">{memory.name}</span>
          {memory.type ? (
            <span className="companion-panel-memory-type">{memory.type}</span>
          ) : null}
          <span className="companion-panel-memory-day">
            {day(memory.updated)}
          </span>
        </summary>
        {memory.description ? <p>{memory.description}</p> : null}
        {memory.body ? (
          <p className="companion-panel-memory-body">{memory.body}</p>
        ) : null}
        <button
          type="button"
          className="secondary-btn companion-panel-memory-delete"
          title={confirming ? "Delete for good" : "Delete this memory"}
          aria-label={`${confirming ? "Delete for good" : "Delete"} ${memory.name}`}
          onClick={() => {
            if (!confirming) return setConfirming(true);
            setConfirming(false);
            void deleteCompanionMemory(memory.file).then((done) => {
              if (done) onDeleted();
              else
                store.notify({
                  kind: "error",
                  message: "The memory could not be deleted",
                });
            });
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          {confirming ? "Delete for good?" : "Delete"}
        </button>
      </details>
    </li>
  );
}

/** The companion's long-term memories, in its panel. */
export function CompanionMemories() {
  const [memories, setMemories] = useState<CompanionMemoryFile[] | null>(null);
  const load = useCallback(() => {
    void listCompanionMemories().then(setMemories);
  }, []);
  useEffect(load, [load]);
  if (!memories) return null;
  return (
    <details className="companion-panel-memories">
      <summary>
        {memories.length
          ? `Memories (${memories.length})`
          : "Memories: none yet"}
      </summary>
      <ul>
        {memories.map((memory) => (
          <MemoryRow key={memory.file} memory={memory} onDeleted={load} />
        ))}
      </ul>
    </details>
  );
}
