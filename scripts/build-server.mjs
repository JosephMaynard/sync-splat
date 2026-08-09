// Bundle the server and the CLI client with esbuild, injecting the package
// version so it is defined in exactly one place (package.json).
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  define: { __VERSION__: JSON.stringify(version) },
};

await build({
  ...common,
  entryPoints: ["server/index.ts"],
  outfile: "dist/server/index.js",
});

await build({
  ...common,
  entryPoints: ["server/cli.ts"],
  outfile: "dist/server/cli.js",
});

console.log(`built dist/server/{index,cli}.js (v${version})`);
