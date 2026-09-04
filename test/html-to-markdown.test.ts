import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/html-to-markdown";

describe("htmlToMarkdown links", () => {
  it("preserves actionable web destinations and functional parameters", () => {
    const output = htmlToMarkdown(
      '<p><a href="https://docs.example.com/view?id=42&utm_source=email&gclid=noise#page">View document</a></p>',
    );

    expect(output).toContain("[View document](https://docs.example.com/view?id=42#page)");
    expect(output).not.toContain("utm_source");
    expect(output).not.toContain("gclid");
  });

  it("keeps mail and telephone destinations useful", () => {
    const output = htmlToMarkdown(
      '<a href="mailto:help@example.com?subject=Question">Email support</a> <a href="tel:+12065550100">Call support</a>',
    );

    expect(output).toContain("Email support (help@example.com)");
    expect(output).toContain("[Call support](tel:+12065550100)");
  });

  it("does not emit dangerous or unsupported schemes as links", () => {
    const output = htmlToMarkdown(
      '<a href="javascript:alert(1)">Run script</a> <a href="data:text/plain,secret">Open data</a>',
    );

    expect(output).toContain("Run script");
    expect(output).toContain("Open data");
    expect(output).not.toContain("javascript:");
    expect(output).not.toContain("data:");
  });
});
