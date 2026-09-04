import type { OAuthCodeData } from "./oauth-utils";

type CodeStoreResponse =
  | { ok: true; code: OAuthCodeData }
  | { ok: false; error: string };

function codeStub(env: Env, code: string): DurableObjectStub {
  return env.AUTHORIZATION_CODES.getByName(code);
}

async function callCodeStore(
  env: Env,
  code: string,
  path: string,
  method: "GET" | "POST",
  body?: OAuthCodeData,
): Promise<CodeStoreResponse> {
  const response = await codeStub(env, code).fetch(`https://oauth-code.internal${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json<CodeStoreResponse>();
}

export async function createAuthorizationCode(
  env: Env,
  code: string,
  data: OAuthCodeData,
): Promise<void> {
  const result = await callCodeStore(env, code, "/create", "POST", data);
  if (!result.ok) throw new Error(result.error);
}

export async function inspectAuthorizationCode(env: Env, code: string): Promise<OAuthCodeData | null> {
  const result = await callCodeStore(env, code, "/inspect", "GET");
  return result.ok ? result.code : null;
}

export async function consumeAuthorizationCode(env: Env, code: string): Promise<OAuthCodeData | null> {
  const result = await callCodeStore(env, code, "/consume", "POST");
  return result.ok ? result.code : null;
}

function json(data: CodeStoreResponse, status = 200): Response {
  return Response.json(data, { status });
}

/** Atomic, single-use storage for one short-lived OAuth authorization code. */
export class OAuthCodeStore {
  private readonly key = "code";

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  private async read(): Promise<OAuthCodeData | null> {
    const code = await this.ctx.storage.get<OAuthCodeData>(this.key);
    if (!code) return null;
    if (code.used || Date.parse(code.expires_at) <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return null;
    }
    return code;
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname;

      if (path === "/create" && request.method === "POST") {
        if (await this.ctx.storage.get(this.key)) {
          return json({ ok: false, error: "Authorization code already exists" }, 409);
        }
        const code = await request.json<OAuthCodeData>();
        await this.ctx.storage.put(this.key, code);
        await this.ctx.storage.setAlarm(Date.parse(code.expires_at));
        return json({ ok: true, code }, 201);
      }

      const code = await this.read();
      if (!code) return json({ ok: false, error: "Authorization code not found" }, 404);

      if (path === "/inspect" && request.method === "GET") {
        return json({ ok: true, code });
      }
      if (path === "/consume" && request.method === "POST") {
        await this.ctx.storage.deleteAll();
        return json({ ok: true, code });
      }
      return json({ ok: false, error: "Unsupported authorization code operation" }, 404);
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
