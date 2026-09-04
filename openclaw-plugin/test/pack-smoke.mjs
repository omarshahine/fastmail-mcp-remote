import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// Prove the installed plugin invokes its package-relative CLI without relying
// on node_modules/.bin or a global fastmail executable.
const packageRoot = join(installDir, "node_modules", "fastmail-cli");
const mockSdkDir = join(installDir, "node_modules", "openclaw", "plugin-sdk");
await mkdir(mockSdkDir, { recursive: true });
await Promise.all([
  writeFile(join(installDir, "node_modules", "openclaw", "package.json"), JSON.stringify({
    name: "openclaw",
    type: "module",
    exports: { "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js" },
  })),
  writeFile(join(mockSdkDir, "plugin-entry.js"), "export const definePluginEntry = (entry) => entry;\n"),
]);
const { default: plugin } = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
const registeredTools = [];
const priorPath = process.env.PATH;
const priorHome = process.env.HOME;
const priorConfigHome = process.env.XDG_CONFIG_HOME;
process.env.PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
process.env.HOME = installDir;
process.env.XDG_CONFIG_HOME = join(installDir, "config");
try {
  plugin.register({
    pluginConfig: { autoDiscover: false, requireApprovals: false },
    registerTool(tool) {
      registeredTools.push(tool);
    },
  });
  const inbox = registeredTools.find((tool) => tool.name === "fastmail_inbox");
  if (!inbox) throw new Error("installed plugin did not register fastmail_inbox");
  const response = await inbox.execute("pack-smoke", { limit: 1 });
  const output = response.content?.[0]?.text || "";
  if (/ENOENT|spawn fastmail/i.test(output)) {
    throw new Error(`installed plugin did not resolve its bundled CLI: ${output}`);
  }
  if (!/^Error:/.test(output)) {
    throw new Error(`expected unauthenticated bundled CLI response, got: ${output}`);
  }
} finally {
  process.env.PATH = priorPath;
  process.env.HOME = priorHome;
  process.env.XDG_CONFIG_HOME = priorConfigHome;
}

console.log("packed CLI smoke test passed");
