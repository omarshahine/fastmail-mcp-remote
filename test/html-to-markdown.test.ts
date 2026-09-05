import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { marked } from "marked";
import { htmlToMarkdown } from "../src/html-to-markdown";

describe("htmlToMarkdown tables", () => {
  it.each(['width="100%"', 'role="presentation"'])(
    "keeps header-table conversion unchanged with %s",
    (attributes) => {
      const rows =
        "<tr><th>Item</th><th>Amount</th></tr><tr><td>Apples</td><td>12</td></tr>";
      const expected = htmlToMarkdown(`<table>${rows}</table>`);

      expect(htmlToMarkdown(`<table ${attributes}>${rows}</table>`)).toBe(expected);
      expect(expected).toBe("Item\n\nAmount\n\nApples\n\n12");
    },
  );

  it.each(['width="100%"', 'role="presentation"'])(
    "flattens outer layouts with %s around a nested data table",
    (attributes) => {
      const dataTable = '<table><tr><th>Item</th></tr><tr><td>Apples</td></tr></table>';
      const output = htmlToMarkdown(
        `<table ${attributes}><tr><td>Welcome</td><td>Latest news</td></tr><tr><td>${dataTable}</td></tr></table>`,
      );

      expect(output).toContain("Welcome\nLatest news");
      expect(output).toContain(htmlToMarkdown(dataTable));
    },
  );

  it("still flattens presentation tables without headers", () => {
    expect(
      htmlToMarkdown(
        '<table role="presentation" width="100%"><tr><td>Welcome</td><td>Latest news</td></tr></table>',
      ),
    ).toBe("Welcome\nLatest news");
  });
});

describe("htmlToMarkdown links", () => {
  it("preserves actionable web destinations and functional parameters", () => {
    const output = htmlToMarkdown(
      '<p><a href="https://docs.example.com/view?id=42&utm_source=email&gclid=noise#page">View document</a></p>',
    );

    expect(output).toContain("[View document](<https://docs.example.com/view?id=42#page>)");
    expect(output).not.toContain("utm_source");
    expect(output).not.toContain("gclid");
  });

  it("keeps mail and telephone destinations useful", () => {
    const output = htmlToMarkdown(
      '<a href="mailto:help@example.com?subject=Question">Email support</a> <a href="tel:+12065550100">Call support</a>',
    );

    expect(output).toContain("Email support (help@example.com)");
    expect(output).toContain("[Call support](<tel:+12065550100>)");
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

  it("cannot turn one telephone anchor into multiple rendered links", () => {
    const output = htmlToMarkdown(
      "<a href='tel:+1) [Click](https://evil.test'>Call</a>",
    );
    const { document } = parseHTML(marked.parse(output) as string);

    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(output).toBe("Call");
  });
});

describe("htmlToMarkdown repeated values", () => {
  it.each([
    ["<p>100 100</p>", "100 100"],
    ["<p>Use AB12 AB12 exactly</p>", "Use AB12 AB12 exactly"],
    ["<p>very very important</p>", "very very important"],
  ])("preserves intentional repetition in %s", (html, expected) => {
    expect(htmlToMarkdown(html)).toContain(expected);
  });

  it("collapses duplicated linked-image alt text only within that link", () => {
    const output = htmlToMarkdown(
      '<a href="https://example.com/product"><img alt="Amazon Alexa" src="image.png">Amazon Alexa</a>',
    );

    expect(output).toBe("[Amazon Alexa](<https://example.com/product>)");
  });
});
