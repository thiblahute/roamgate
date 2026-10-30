/**
 * Every review surface the behavior tests run against. The classic review
 * pane today; the review in Changes joins once it exists (plan: review into
 * the inspector, phase 3), and each shared test then runs on both.
 */
import { mountClassicReview } from "./reviewSurface.classic.testkit";
import type { ReviewSurface, SurfaceOptions } from "./reviewSurface.testkit";

export const REVIEW_SURFACES: {
  name: string;
  mount: (options: SurfaceOptions) => Promise<ReviewSurface>;
}[] = [{ name: "classic", mount: mountClassicReview }];
