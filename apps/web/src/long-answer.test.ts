import { describe, expect, it } from "vitest";
import { answerHead } from "./long-answer.ts";

describe("the start of a long answer", () => {
  it("gives a short answer whole", () => {
    expect(answerHead("Bonjour", 100)).toEqual({ head: "Bonjour", left: 0 });
  });

  it("cuts a long one between two paragraphs, and counts what is left", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
    const { head, left } = answerHead(text, 100);
    expect(head).toBe("a".repeat(60));
    expect(head.length + left).toBe(text.length);
  });

  it("never cuts inside a block of code", () => {
    const code = "```ts\n" + "const x = 1;\n\n".repeat(20) + "```";
    const text = `Avant.\n\n${code}\n\nAprès.`;
    expect(answerHead(text, 100).head).toBe("Avant.");
    // A block that opens the answer is drawn whole rather than cut.
    expect(answerHead(`${code}\n\nAprès.`, 100).head).toBe(code);
  });
});

// Neon's review of #197.
describe("the start of a long answer, at its edges", () => {
  it("offers no more when a single block of code was all of it", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(20) + "```\n";
    expect(answerHead(code, 100)).toEqual({ head: code, left: 0 });
  });

  it("knows a ``` inside a ~~~ block does not close it", () => {
    const block = "~~~md\n```js\nconst a = 1;\n```\n" + "ligne\n\n".repeat(20) + "~~~";
    const text = `Avant.\n\n${block}\n\nAprès.`;
    expect(answerHead(text, 80).head).toBe("Avant.");
  });

  it("does not take the opening fence of a text without a line break for its end", () => {
    const text = "```" + "a".repeat(200);
    expect(answerHead(text, 100)).toEqual({ head: text, left: 0 });
  });
});
