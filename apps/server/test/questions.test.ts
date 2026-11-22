import { describe, expect, it } from "vitest";
import { toolQuestions } from "../src/questions.ts";

describe("questions an agent asks with a tool", () => {
  it("reads Antigravity's ask_question", () => {
    expect(
      toolQuestions({
        questions: [
          {
            is_multi_select: false,
            options: ["(Recommended) Blue", "Green", "Red", "Purple"],
            question: "Which colour do you prefer?",
          },
        ],
      }),
    ).toEqual([
      {
        question: "Which colour do you prefer?",
        options: ["(Recommended) Blue", "Green", "Red", "Purple"],
      },
    ]);
  });

  it("reads options given with a label, and several choices at once", () => {
    expect(
      toolQuestions({
        questions: [
          { question: "Quoi ?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
        ],
      }),
    ).toEqual([{ question: "Quoi ?", options: ["A", "B"], multi: true }]);
  });

  it("takes nothing else for a question", () => {
    expect(toolQuestions(undefined)).toBeUndefined();
    expect(toolQuestions({ Path: "a.txt", Content: "ok" })).toBeUndefined();
    expect(toolQuestions({ questions: "non" })).toBeUndefined();
    expect(
      toolQuestions({ questions: [{ question: "Seule ?", options: ["Oui"] }] }),
    ).toBeUndefined();
    expect(
      toolQuestions({ questions: [{ question: "", options: ["A", "B"] }, null] }),
    ).toBeUndefined();
  });
});
