import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binPath = fileURLToPath(new URL("../cli/bin.sh", import.meta.url));

describe("fastmail CLI bin", () => {
  it("uses the package-local runtime and starts outside the repository", async () => {
    const source = await readFile(binPath, "utf8");
    expect(source).not.toMatch(/\bnpx\b/);
    expect(source).toContain("../node_modules/.bin/tsx");

    const { stdout, stderr } = await execFileAsync(binPath, ["--help"], {
      cwd: tmpdir(),
      env: { ...process.env, npm_config_offline: "true" },
    });
    expect(stdout).toContain("Fastmail CLI");
    expect(stderr).not.toContain("Need to install");
  });
});
