import type { WorkMeta, WorkService } from "./service";
import { WorkError } from "./store";

/**
 * `bridge.work.*`: the Work board for every browser, machine-wide like
 * `bridge.mr_reviews.*`. The pages read the board and write the user's
 * changes; agents write through the tools (work/tools.ts) with `by: agent`.
 */

export function isWorkMethod(method: string): boolean {
  return method.startsWith("bridge.work.");
}

function metaOf(params: Record<string, unknown>): WorkMeta {
  return params.by === "agent"
    ? {
        by: "agent",
        ...(typeof params.summary === "string"
          ? { summary: params.summary.slice(0, 200) }
          : {}),
      }
    : { by: "user" };
}

export async function handleWorkRpc(
  service: WorkService,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const meta = metaOf(params);
  switch (method) {
    case "bridge.work.board":
      return service.board();
    case "bridge.work.list":
      return { items: await service.list(params) };
    case "bridge.work.project.set":
      return { project: service.projectSet(params, meta) };
    case "bridge.work.add": {
      const { item, updated } = await service.addOrUpdate(params, meta);
      return { item, ...(updated ? { updated } : {}) };
    }
    case "bridge.work.update":
      return { item: await service.update(params, meta) };
    case "bridge.work.done":
      return { item: service.done(params, meta) };
    case "bridge.work.reopen":
      return { item: await service.reopen(params, meta) };
    case "bridge.work.remove":
      return { item: service.remove(params, meta) };
    case "bridge.work.threads":
      return { snapshot: service.threads(params) };
    case "bridge.work.promote":
      return { item: await service.promote(params, meta) };
    case "bridge.work.owner_target":
      return { target: await service.ownerTarget(params) };
    case "bridge.work.adopt":
      return { item: service.adopt(params, meta) };
    case "bridge.work.check":
      return service.check();
    default:
      throw new WorkError(`unknown method ${method.slice(0, 60)}`, "not_found");
  }
}
