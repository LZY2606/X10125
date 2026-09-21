import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const viteBin = resolve(here, "..", "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [viteBin, ...args], {
  stdio: "inherit",
  cwd: resolve(here, "..")
});
child.on("exit", (code) => process.exit(code ?? 0));
