import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { promptSecret, registerOAuthClient, saveConfigAt, startCallbackServer, type Config } from "../cli/auth";

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

describe("CLI OAuth client registration", () => {
  it("registers a fresh loopback client for an auth flow", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ client_id: "fresh-client" }));

    await expect(registerOAuthClient("https://worker.example", fetchImpl as typeof fetch))
      .resolves.toBe("fresh-client");
    expect(fetchImpl).toHaveBeenCalledWith("https://worker.example/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "fastmail-cli",
        redirect_uris: ["http://127.0.0.1/callback"],
      }),
    });
  });
});

describe("CLI secret prompt", () => {
  it("shows the prompt without echoing the entered token", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let displayed = "";
    output.on("data", (chunk) => {
      displayed += chunk.toString();
    });

    const answer = promptSecret("Paste token: ", input, output);
    input.end("example-bearer-token\n");

    await expect(answer).resolves.toBe("example-bearer-token");
    expect(displayed).toBe("Paste token: \n");
    expect(displayed).not.toContain("example-bearer-token");
  });
});
