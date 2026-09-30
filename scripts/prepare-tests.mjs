import { build } from "esbuild";
// Upstream's subprocess regression imports emitted JS outside Vitest.
await build({
  entryPoints: ["src/persistence.ts"],
  outfile: "node_modules/.cache/pi-extensions-test/packages/pi-goal/src/persistence.js",
  bundle: true, platform: "node", format: "esm", packages: "external",
});
