/**
 * Where the page sends an HTTP path. A page served by the desktop or the
 * phone sends every path to its own origin, unchanged; a page a Roamgate node
 * served sends the home's routes to the home (routedBridge.ts installs the
 * router once the node's hello names its home).
 */
let router: ((path: string) => string) | null = null;

export function setHttpRouter(next: ((path: string) => string) | null): void {
  router = next;
}

/** The URL the page uses for `path`: the path itself unless routed. */
export function routeHttpUrl(path: string): string {
  return router ? router(path) : path;
}
