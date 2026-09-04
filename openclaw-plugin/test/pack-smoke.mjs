import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const packDir = await mkdtemp(join(tmpdir(), "fastmail-cli-pack-"));
const packOutput = run(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
  pluginDir,
);
const [{ filename }] = JSON.parse(packOutput);
const tarball = join(packDir, filename);

const installDir = await mkdtemp(join(tmpdir(), "fastmail-cli-install-"));
await writeFile(join(installDir, "package.json"), JSON.stringify({ private: true }));
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDir);

const executable = join(installDir, "node_modules", ".bin", "fastmail");
await access(executable);
const help = run(executable, ["--help"], installDir);
if (!help.includes("Token-efficient Fastmail CLI")) {
  throw new Error("installed fastmail executable did not render CLI help");
}

console.log("packed CLI smoke test passed");
