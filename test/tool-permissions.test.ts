import { describe, expect, it } from "vitest";
import { TOOL_CATEGORIES } from "../src/permissions";
import { registerAllTools } from "../src/tools";

describe("tool permission category completeness", () => {
  it("categorizes every registered tool", () => {
    const registered: string[] = [];
    const server = {
      tool(name: string) {
        registered.push(name);
      },
    };

    registerAllTools(server as never, {} as never);

    expect(registered.sort()).toEqual(Object.keys(TOOL_CATEGORIES).sort());
  });
});
