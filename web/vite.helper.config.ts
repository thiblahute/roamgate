import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The script a rendered review's pages run (src/renderedHelper.ts), built
 * as a classic script into contract/assets/js: both servers embed it and
 * call `roamgateRenderedHelper` (server/src/http/rendered-helper.ts).
 * Unminified, so a change reads as a diff, and without comments: they are
 * the source's, not the page's. `ROAMGATE_HELPER_OUT_DIR`
 * builds elsewhere (the test comparing the build with the committed file).
 */
export default defineConfig({
  logLevel: "warn",
  publicDir: false,
  build: {
    // The app's own browser baseline (vite.config.ts).
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
    outDir:
      process.env.ROAMGATE_HELPER_OUT_DIR ??
      fileURLToPath(new URL("../contract/assets/js", import.meta.url)),
    emptyOutDir: false,
    minify: false,
    copyPublicDir: false,
    rolldownOptions: { output: { comments: false } },
    lib: {
      entry: fileURLToPath(new URL("./src/renderedHelper.ts", import.meta.url)),
      formats: ["iife"],
      name: "roamgateRenderedHelper",
      fileName: () => "rendered-helper.js",
    },
  },
});
