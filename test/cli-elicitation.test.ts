import { beforeEach, describe, expect, it, vi } from "vitest";

const ctor = vi.hoisted(() => vi.fn());
const setHandler = vi.hoisted(() => vi.fn());
const interactiveFlag = vi.hoisted(() => ({ value: false }));

vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    constructor(...args: unknown[]) {
      ctor(...args);
    }
    setRequestHandler = setHandler;
    connect = vi.fn().mockResolvedValue(undefined);
    callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
  },
  StreamableHTTPClientTransport: class {},
}));

vi.mock("../cli/elicitation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/elicitation.js")>();
  return { ...actual, isInteractive: () => interactiveFlag.value };
});

import { FastmailMcpClient } from "../cli/mcp-client.js";
import { createElicitationHandler, type PromptIO } from "../cli/elicitation.js";
const { isInteractive } = await vi.importActual<typeof import("../cli/elicitation.js")>("../cli/elicitation.js");

function fakeIO(answers: (string | null)[]) {
  const writes: string[] = [];
  const questions: string[] = [];
  const openUrl = vi.fn().mockResolvedValue(undefined);
  const io: PromptIO = {
    ask: async (q) => {
      questions.push(q);
      return answers.length ? (answers.shift() as string | null) : null;
    },
    write: (t) => void writes.push(t),
    openUrl,
  };
  return { io, writes, questions, openUrl };
}

describe("client capabilities", () => {
  beforeEach(() => {
    ctor.mockClear();
    setHandler.mockClear();
  });

  it("non-interactive client declares no elicitation capability", async () => {
    interactiveFlag.value = false;
    await new FastmailMcpClient("https://w.example", "t").callTool("x");
    const [, options] = ctor.mock.calls[0];
    expect(options.capabilities).toEqual({});
    expect(options.versionNegotiation).toEqual({ mode: "auto" });
    expect(setHandler).not.toHaveBeenCalled();
  });

  it("interactive client declares form and url", async () => {
    interactiveFlag.value = true;
    await new FastmailMcpClient("https://w.example", "t").callTool("x");
    const [, options] = ctor.mock.calls[0];
    expect(options.capabilities).toEqual({ elicitation: { form: {}, url: {} } });
    expect(setHandler).toHaveBeenCalledWith("elicitation/create", expect.any(Function));
  });
});

describe("isInteractive", () => {
  const tty = { isTTY: true };
  it("requires both TTYs", () => {
    expect(isInteractive({}, tty, tty)).toBe(true);
    expect(isInteractive({}, { isTTY: false }, tty)).toBe(false);
    expect(isInteractive({}, tty, {})).toBe(false);
  });
  it("FASTMAIL_NONINTERACTIVE=1 forces non-interactive", () => {
    expect(isInteractive({ FASTMAIL_NONINTERACTIVE: "1" }, tty, tty)).toBe(false);
  });
});

describe("elicitation handler", () => {
  const url = "https://mail.example.test/approve?x=1";
  const urlReq = { params: { mode: "url", message: "Approve send", url, elicitationId: "e1" } } as any;

  it.each([
    ["y", "accept", 1],
    ["n", "decline", 0],
    [null, "cancel", 0],
  ] as const)("url elicitation opens only after yes (%s)", async (answer, action, opens) => {
    const { io, openUrl } = fakeIO([answer]);
    const result = await createElicitationHandler(io)(urlReq);
    expect(result.action).toBe(action);
    expect(openUrl).toHaveBeenCalledTimes(opens);
  });

  it("url prompt shows full URL and host", async () => {
    const { io, writes, questions } = fakeIO(["n"]);
    await createElicitationHandler(io)(urlReq);
    const out = writes.join("");
    expect(out).toContain(url);
    expect(out).toContain("host: mail.example.test");
    expect(questions[0]).toBe("Open in browser? [y/N] ");
  });

  const form = (properties: Record<string, unknown>) =>
    ({ params: { mode: "form", message: "Confirm", requestedSchema: { type: "object", properties } } }) as any;

  it("form boolean uses default on empty input", async () => {
    const { io } = fakeIO([""]);
    const r = await createElicitationHandler(io)(form({ confirm: { type: "boolean", default: false } }));
    expect(r).toEqual({ action: "accept", content: { confirm: false } });
  });

  it("form number re-asks on invalid input", async () => {
    const f = fakeIO(["abc", "7"]);
    const r: any = await createElicitationHandler(f.io)(form({ n: { type: "number" } }));
    expect(r.content.n).toBe(7);
    expect(f.questions).toHaveLength(2);
  });

  it("form enum accepts a numbered choice", async () => {
    const f = fakeIO(["2"]);
    const r: any = await createElicitationHandler(f.io)(form({ c: { type: "string", enum: ["a", "b"] } }));
    expect(r.content.c).toBe("b");
  });

  it("form EOF cancels", async () => {
    const r = await createElicitationHandler(fakeIO([null]).io)(form({ confirm: { type: "boolean" } }));
    expect(r.action).toBe("cancel");
  });
});
