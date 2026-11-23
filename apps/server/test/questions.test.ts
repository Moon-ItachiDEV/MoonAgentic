import { describe, expect, it } from "vitest";
import { formContent, formQuestions, toolQuestions } from "../src/questions.ts";

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

  it("keeps each option once", () => {
    expect(
      toolQuestions({ questions: [{ question: "Quoi ?", options: ["A", "B", " A ", "B"] }] }),
    ).toEqual([{ question: "Quoi ?", options: ["A", "B"] }]);
    expect(
      toolQuestions({ questions: [{ question: "Quoi ?", options: ["A", "A"] }] }),
    ).toBeUndefined();
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

describe("questions an agent asks with a form", () => {
  const schema = {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        oneOf: [
          { const: "Kafka", title: "Kafka", description: "Journal durable" },
          {
            const: "SQS",
            title: "SQS",
            _meta: { "_claude/askUserQuestionOption": { preview: "send(event)" } },
          },
        ],
      },
      question_0_custom: { type: "string", title: "Other" },
      question_1: {
        type: "array",
        description: "Quels tests ?",
        items: { anyOf: [{ const: "Unitaires" }, { const: "E2E" }] },
      },
    },
  };

  it("keeps what an option says and shows, from a tool's own input too", () => {
    expect(
      toolQuestions({
        questions: [
          {
            question: "Quelle file ?",
            options: [
              { label: "Kafka", description: "Journal durable" },
              { label: "SQS", preview: "send(event)" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        question: "Quelle file ?",
        options: ["Kafka", "SQS"],
        descriptions: ["Journal durable", ""],
        previews: ["", "send(event)"],
      },
    ]);
  });

  it("reads Claude Code's questions, each with the field its answer goes back in", () => {
    const one = formQuestions("Quelle file ?", {
      properties: {
        question_0: schema.properties.question_0,
        question_0_custom: schema.properties.question_0_custom,
      },
    });
    expect(one).toEqual({
      questions: [
        {
          question: "Quelle file ?",
          options: ["Kafka", "SQS"],
          descriptions: ["Journal durable", ""],
          previews: ["", "send(event)"],
        },
      ],
      fields: [{ key: "question_0", multi: false, custom: "question_0_custom" }],
    });
    const two = formQuestions("Please answer the following questions.", {
      properties: {
        question_0: { ...schema.properties.question_0, description: "Quelle file ?" },
        question_1: schema.properties.question_1,
      },
    });
    expect(two?.questions.map((q) => [q.question, q.multi])).toEqual([
      ["Quelle file ?", undefined],
      ["Quels tests ?", true],
    ]);
  });

  it("does not read a form with anything but choices", () => {
    expect(
      formQuestions("Ton nom ?", { properties: { name: { type: "string" } } }),
    ).toBeUndefined();
    expect(formQuestions("Rien", { properties: {} })).toBeUndefined();
    expect(formQuestions("Rien", null)).toBeUndefined();
  });

  it("sends back picks the form offers, and the user's own words where it takes them", () => {
    const form = formQuestions("x", {
      properties: {
        ...schema.properties,
        question_0: { ...schema.properties.question_0, description: "Quelle file ?" },
      },
    })!;
    expect(formContent(form, [{ picks: ["SQS"] }, { picks: ["E2E", "Autre"] }])).toEqual({
      question_0: "SQS",
      question_1: ["E2E"],
    });
    expect(
      formContent(form, [
        { picks: [], text: " Redis " },
        { picks: [], text: "Aucun" },
      ]),
    ).toEqual({ question_0_custom: "Redis", question_1: ["Aucun"] });
  });
});
