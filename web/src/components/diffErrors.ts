/** What a refused read means, in words (the server's are for logs). */
export function plainDiffError(error: string) {
  if (/root is not a repository of this workspace/.test(error))
    return "This repository is not one of this workspace's, so this view of it cannot be read here.";
  if (
    /root is not a repository's top level|root must be an absolute path/.test(
      error,
    )
  )
    return "This folder is not a repository's top level, so its changes cannot be read.";
  return error;
}
