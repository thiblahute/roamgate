import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewPush } from "../../../shared/review";
import { createReviewService } from "./service";
import { openReviewStorage } from "./storage";

type ServiceOptions = Parameters<typeof createReviewService>[0];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A service with isolated storage, captured pushes and agent prompts. */
export function reviewServiceForTest(
  overrides: Partial<ServiceOptions> & { dir?: string } = {},
) {
  const { dir: providedDir, ...options } = overrides;
  const dir = providedDir ?? mkdtempSync(join(tmpdir(), "roamgate-review-"));
  if (!providedDir)
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const pushes: ReviewPush[] = [];
  const prompts: { connectionId: string; paneId: string; text: string }[] = [];
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: (push) => pushes.push(push),
    loadDiff: async () => ({ files: [], truncated: false }),
    promptAgent: async (connectionId, paneId, text) => {
      prompts.push({ connectionId, paneId, text });
    },
    ...options,
  });
  cleanups.push(() => service.close());
  return { dir, service, pushes, prompts };
}
