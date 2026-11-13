import {
  applyMrOrderOp,
  flattenMrSections,
  MR_SECTION_ORDER,
  type MrOrderOp,
  orderMrEntries,
} from "../../../shared/mrReviewsOrder";

/**
 * A stand-in for the bridge's `bridge.mr_reviews.order`, for the panel's
 * tests: applies an operation to the listed entries in the order kept, the
 * way the server does, and returns the new order (requests gone are left out).
 */
export function fakeOrderRpc(
  entries: { key: string; section: string }[],
  order: string[],
  params: Record<string, unknown>,
): string[] {
  const sections = Object.fromEntries(
    MR_SECTION_ORDER.map((name) => [
      name,
      orderMrEntries(
        entries.filter((entry) => entry.section === name),
        order,
      ).map((entry) => entry.key),
    ]),
  ) as Record<(typeof MR_SECTION_ORDER)[number], string[]>;
  const outcome = applyMrOrderOp(sections, params as unknown as MrOrderOp);
  return flattenMrSections(outcome.sections);
}
