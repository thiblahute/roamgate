import type { AgentChatEventEnvelope } from "../../../shared/agentChat";
import { createLeaseStore, type LeaseStore } from "./lease";
import type { HolderStatus } from "./pane-child";
import {
  type ConversationServiceOptions,
  createConversationService,
} from "./service";
import { fakeHerdr, fakeSpawner, settle, virtualClock } from "./testing";

/** The pane the service tests drive, and the browsers they subscribe. */
export const PANE = "w1:p1";
export type Ws = { name: string };

const services: { dispose(): void }[] = [];

/** Disposes the services the last test set up (its `afterEach`). */
export function disposeServices() {
  for (const service of services.splice(0)) service.dispose();
}

/** Runs `dispose` with the services, after the test. */
export function disposeLater(dispose: () => void) {
  services.push({ dispose });
}

/**
 * A conversation service on a fake Herdr and fake headless processes;
 * the holder Herdr is told to type polls the service as `PANE`'s.
 */
export function setupService(
  leases?: LeaseStore,
  extra: Partial<ConversationServiceOptions<Ws>> = {},
  /** What the holder typed into the pane says of itself as it polls. */
  holder: { status?: HolderStatus } = {},
) {
  const clock = virtualClock();
  const sent: [Ws, AgentChatEventEnvelope][] = [];
  const spawner = fakeSpawner();
  const ref: {
    service?: ReturnType<typeof createConversationService<Ws>>;
  } = {};
  const holderPolls: Promise<unknown>[] = [];
  const holderAborts: AbortController[] = [];
  const startHolder = () => {
    const controller = new AbortController();
    holderAborts.push(controller);
    holderPolls.push(
      ref.service!.holder.hold({
        paneId: PANE,
        sessionId: fake.sessionId,
        signal: controller.signal,
        ...(holder.status ? { status: holder.status } : {}),
      }),
    );
  };
  const fake = fakeHerdr({ onHolder: startHolder });
  const store = leases ?? createLeaseStore({ connectionId: "c1", file: null });
  const service = createConversationService<Ws>({
    connectionId: "c1",
    herdr: fake.herdr,
    leases: store,
    spawn: spawner.spawn,
    ask: async () => "allow",
    readImage: async () => ({ media_type: "image/png", data: "" }),
    send: (ws, envelope) => sent.push([ws, envelope]),
    holderCommand: (id) => `hold ${id}\r`,
    handover: { sleep: clock.sleep, now: clock.now, confirmTimeoutMs: 1000 },
    session: { stopWaitMs: 50, interruptWaitMs: 50 },
    holdPollMs: 60_000,
    ...extra,
  });
  ref.service = service;
  services.push({
    dispose() {
      for (const controller of holderAborts) controller.abort();
      service.dispose();
    },
  });
  return {
    service,
    fake,
    spawner,
    sent,
    store,
    holderPolls,
    holderAborts,
    startHolder,
    clock,
  };
}

/** Waits (real time, briefly) until the check holds. */
export async function eventually(check: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(1);
    await settle();
  }
}

/** The texts of the user messages written to a fake claude. */
export function userTexts(fake: { written: Record<string, unknown>[] }) {
  return fake.written
    .filter((message) => message.type === "user")
    .map((message) => (message.message as { content: unknown }).content);
}

/** The pane as conversation mode leaves it: the holder in its shell. */
export function heldPane(fake: ReturnType<typeof fakeHerdr>) {
  fake.live.delete(fake.claudePid);
  fake.pane.agent = null;
  fake.pane.process = {
    shell_pid: 800,
    foreground_process_group_id: 950,
    foreground_processes: [{ pid: 950, argv: ["python3", "roamgate-hold"] }],
  };
}
