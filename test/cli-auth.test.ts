import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfigAt, startCallbackServer, type Config } from "../cli/auth";

const CONFIG: Config = {
  url: "https://worker.example",
  clientId: "client-1",
  teamName: "team",
  token: "secret-token",
  tokenExpiresAt: "2099-01-01T00:00:00.000Z",
};

describe("CLI credential cache permissions", () => {
  it("repairs permissive modes on an existing directory and token file", async () => {
    const root = await mkdtemp(join(tmpdir(), "fastmail-cli-auth-"));
    const configDir = join(root, "config");
    const configFile = join(configDir, "config.json");
    await mkdir(configDir, { mode: 0o755 });
    await writeFile(configFile, "{}", { mode: 0o644 });

    await saveConfigAt(CONFIG, configDir, configFile);

    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
  });
});

describe("CLI OAuth callback state", () => {
  it.each(["", "wrong-state"])("ignores a callback with state %j", async (state) => {
    const expectedState = "expected-state";
    const { port, codePromise, server } = await startCallbackServer(expectedState);
    try {
      const invalid = await fetch(
        `http://127.0.0.1:${port}/callback?code=attacker-code&state=${encodeURIComponent(state)}`,
      );
      expect(invalid.status).toBe(400);
      await expect(Promise.race([
        codePromise.then(() => "settled"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 25)),
      ])).resolves.toBe("pending");

      const valid = await fetch(
        `http://127.0.0.1:${port}/callback?code=real-code&state=${expectedState}`,
      );
      expect(valid.status).toBe(200);
      await expect(codePromise).resolves.toBe("real-code");
    } finally {
      server.close();
    }
  });
});
