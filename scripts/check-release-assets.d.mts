/** The release's asset names for `version` (X.Y.Z), every target's. */
export function releaseAssetNames(version: string): string[];

/** Fails unless `names` are exactly the release's asset names. */
export function verifyReleaseAssetNames(
  names: readonly string[],
  version: string,
): void;
