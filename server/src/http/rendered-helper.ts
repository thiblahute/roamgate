import { RENDERED_HELPER_JS } from "../assets";
import type { RenderedRootMap } from "../../../shared/renderedPage";

/**
 * The helper, called with its prefix, as the body of a `<script>`. The
 * helper itself is web/src/renderedHelper.ts, built into
 * contract/assets/js/rendered-helper.js: a classic script whose one
 * top-level `var` is kept inside the call's function, out of the page's
 * globals.
 */
export function renderedHelperSource(
  prefix: string,
  root: RenderedRootMap = { base: "/", to: prefix },
  storage: Record<string, string> | null = null,
): string {
  // `<` cannot occur in the prefix (a token path), so the script cannot be
  // closed early; escape it anyway.
  const quoted = JSON.stringify(prefix).replace(/</g, "\\u003c");
  const rooted = JSON.stringify(root).replace(/</g, "\\u003c");
  // The items are the page's own, untrusted text: `<` (a `</script>`) and the
  // line separators are escaped so no value can end or break the script.
  const stored = JSON.stringify(storage)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function(){${RENDERED_HELPER_JS}\nroamgateRenderedHelper(${quoted}, ${rooted}, ${stored});})();`;
}
