// @vitest-environment jsdom
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { descriptionToPlainText } from "./descriptionText";

afterEach(() => vi.unstubAllGlobals());

const cases = [
  [
    "plain punctuation",
    "Don't change Jane’s name, 2 < 3, or A > B.",
    "Don't change Jane’s name, 2 < 3, or A > B.",
  ],
  [
    "plain newlines",
    "First line\r\nSecond line\n\nNext paragraph",
    "First line\nSecond line\n\nNext paragraph",
  ],
  [
    "entities decoded once",
    "&amp; &lt;3 &quot;yes&quot; &#39; &#x1F4DA; &nbsp; &mdash; &amp;lt;",
    '& <3 "yes" \' 📚 — &lt;',
  ],
  [
    "paragraph and line breaks",
    "<p>First <strong>paragraph</strong>.</p><p>Second<br>line.</p>",
    "First paragraph.\n\nSecond\nline.",
  ],
  [
    "list boundaries",
    "<div>Steps</div><ul><li>One</li><li>Two <em>words</em></li></ul>",
    "Steps\nOne\nTwo words",
  ],
  [
    "non-display content",
    "Before<script>secret()</script><style>secret{}</style><template>secret<template>nested</template>secret</template><noscript>secret</noscript>After",
    "BeforeAfter",
  ],
  ["comments", "A<!-- do not display <p>this</p> -->B", "AB"],
  ["quoted angle brackets", '<p title="a > b">Visible</p>', "Visible"],
  [
    "unfinished excluded content",
    "Visible<script>unfinished secret",
    "Visible",
  ],
  [
    "unknown entities",
    "&unknownEntity; &constructor; and &#0;",
    "&unknownEntity; &constructor; and �",
  ],
  ["empty", "", ""],
] as const;

describe.each(["browser", "without DOM"])(
  "description text (%s)",
  (environment) => {
    it.each(cases)("handles %s", (_name, input, expected) => {
      if (environment === "without DOM") vi.stubGlobal("document", undefined);
      expect(descriptionToPlainText(input)).toBe(expected);
    });
  },
);

it("uses HTML parsing to decode named publishing entities and repair malformed paragraphs", () => {
  expect(
    descriptionToPlainText("<p>&eacute; &NotEqualTilde; <b>bold<p>Next"),
  ).toBe("é ≂̸ bold\n\nNext");
});

it("never executes markup or requests embedded resources even with loading enabled", async () => {
  // ResourceLoader intercepts all resource attempts: this test never uses the network.
  const { JSDOM, ResourceLoader } = createRequire(import.meta.url)("jsdom");
  const requested = vi.fn();
  class NoNetwork extends ResourceLoader {
    fetch(url: string) {
      requested(url);
      return null;
    }
  }
  const isolated = new JSDOM("<!doctype html><body></body>", {
    url: "https://reader.invalid/",
    runScripts: "dangerously",
    resources: new NoNetwork(),
  });
  try {
    vi.stubGlobal("document", isolated.window.document);
    const upgraded = vi.fn();
    isolated.window.customElements.define(
      "reader-probe",
      class extends isolated.window.HTMLElement {
        constructor() {
          super();
          upgraded();
        }
      },
    );
    const output = descriptionToPlainText(`
      <script>window.executed = true</script>
      <script src="https://untrusted.invalid/code.js"></script>
      <style>@import url(https://untrusted.invalid/style.css)</style>
      <link rel="stylesheet" href="https://untrusted.invalid/sheet.css">
      <img src="https://untrusted.invalid/cover.png" onerror="window.executed = true">
      <iframe src="https://untrusted.invalid/frame" srcdoc="<script>parent.executed=true</script>"></iframe>
      <reader-probe>Visible &amp; safe</reader-probe>
      <a href="javascript:window.executed=true" onclick="window.executed=true">link</a>
    `);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output).toBe("Visible & safe link");
    expect(requested).not.toHaveBeenCalled();
    expect(upgraded).not.toHaveBeenCalled();
    expect(isolated.window.executed).toBeUndefined();
    expect(isolated.window.document.body.childNodes).toHaveLength(0);
  } finally {
    isolated.window.close();
  }
});
