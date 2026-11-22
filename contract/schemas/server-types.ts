/**
 * The server-local types that are part of the contract: wire messages and
 * file formats declared next to their code rather than in shared/. The
 * schema generator reads them through this list
 * (scripts/contract/schemas.ts); a type added here gets its schema in
 * contract/schemas/server.schema.json.
 */
export type { ForwardWire } from "../../server/src/bridge/ssh-forward";
export type { ListDeltaReply } from "../../server/src/bridge/list-delta";
export type {
  VoiceEvent,
  CallEvent,
} from "../../server/src/voice/voice-helper";
export type { TaskEvent } from "../../server/src/notifications/task-events";
export type { ActivityEvent } from "../../server/src/activity/protocol";
export type { TimelineReply } from "../../server/src/activity/timeline-rpc";
export type { PresenceReply } from "../../server/src/activity/recorder";
export type { ConnectionRpcRequest } from "../../server/src/connections/rpc-routing";
export type { HolderReply } from "../../server/src/conversation/holder";
export type { PermissionRequest } from "../../server/src/review/prompts";
export type { LedgerFile } from "../../server/src/mr-reviews/efforts";
export type { LowGpuFile } from "../../server/src/voice/voice-low-gpu";
export type { TasteFile } from "../../server/src/voice/voice-taste";
export type { MemoryFile } from "../../server/src/voice/voice-memory-files";
export type { HolderSaved } from "../../server/src/conversation/pane-child";
export type { SavedTaskState } from "../../server/src/assistant/tasks";
