import type { Item, PermissionOption } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  answerText,
  cardKey,
  openQuestion,
  optionLabel,
  permissionChoices,
  questionChoices,
  waits,
} from "./decision.ts";

const user: Item = { id: "u", kind: "user", text: "Salut", at: 1 };
const ask = (over: Partial<Extract<Item, { kind: "tool" }>> = {}): Item => ({
  id: "t",
  kind: "tool",
  title: "ask_question",
  toolKind: "other",
  status: "pending",
  content: [],
  questions: [{ question: "Quoi ?", options: ["A", "B"] }],
  at: 2,
  ...over,
});
const idle = { id: "here", status: "idle", archived: false } as const;
const options: PermissionOption[] = [
  { optionId: "no", name: "Refuser", kind: "reject_once" },
  { optionId: "always", name: "Toujours", kind: "allow_always" },
  { optionId: "yes", name: "Autoriser", kind: "allow_once" },
];

describe("what waits on the user", () => {
  it("keeps a tool's question open until the user writes again", () => {
    expect(openQuestion([user, ask()], idle)?.id).toBe("t");
    expect(openQuestion([user, ask(), { ...user, id: "u2" }], idle)).toBeUndefined();
    expect(openQuestion([user, ask()], { ...idle, status: "running" })).toBeUndefined();
    expect(openQuestion([user, ask()], { ...idle, archived: true })).toBeUndefined();
    // A question the agent holds its turn on is answered another way.
    expect(openQuestion([user, ask({ form: "answered" })], idle)).toBeUndefined();
  });

  it("lists this thread's first, then the oldest, of every kind", () => {
    const list = waits({
      thread: idle,
      items: [user, ask()],
      requests: [
        { threadId: "other", itemId: "p1", title: "Écrire", options, at: 1 },
        { threadId: "here", itemId: "p2", title: "Lancer", options, at: 9 },
      ],
      questions: [{ threadId: "other", itemId: "q1", questions: [], at: 0 }],
    });
    expect(list.map((w) => [w.id, w.kind])).toEqual([
      ["t", "question"],
      ["p2", "permission"],
      ["q1", "question"],
      ["p1", "permission"],
    ]);
    expect(list[0]).toMatchObject({ via: "message" });
    expect(list[2]).toMatchObject({ via: "form" });
    expect(waits({ thread: idle, items: [], requests: [], questions: [], own: true })).toEqual([]);
    expect(
      waits({
        thread: idle,
        items: [],
        requests: [{ threadId: "other", itemId: "p1", title: "Écrire", options, at: 1 }],
        questions: [],
        own: true,
      }),
    ).toEqual([]);
  });
});

describe("the card's rows", () => {
  it("reads the option an agent recommends", () => {
    expect(optionLabel("(Recommandé) Bleu")).toEqual({ label: "Bleu", recommended: true });
    expect(optionLabel("Kafka (Recommended)")).toEqual({ label: "Kafka", recommended: true });
    expect(optionLabel("Vert")).toEqual({ label: "Vert", recommended: false });
    expect(optionLabel("(Recommandé)")).toEqual({ label: "(Recommandé)", recommended: false });
  });

  it("sends back the option as the agent wrote it", () => {
    expect(
      questionChoices({
        question: "Quoi ?",
        options: ["Kafka (Recommandé)", "SQS"],
        descriptions: ["Durable", ""],
        previews: ["", "send()"],
      }),
    ).toEqual([
      { value: "Kafka (Recommandé)", label: "Kafka", description: "Durable", recommended: true },
      { value: "SQS", label: "SQS", preview: "send()" },
    ]);
  });

  it("puts allowing first and says what each permission choice does", () => {
    expect(permissionChoices(options).map((c) => [c.value, c.description])).toEqual([
      ["yes", "Autorisé cette fois seulement"],
      ["always", "Autorisé sans redemander pour ce genre d'action"],
      ["no", "L'agent ne le fait pas et continue autrement"],
    ]);
  });

  it("says what a choice does from its kind, whatever name the agent gave it", () => {
    // An agent that names « Refuser » the choice that allows for good.
    const lying = [
      { optionId: "a", name: "Refuser", kind: "allow_always" },
      { optionId: "b", name: "Autoriser une fois", kind: "reject_once" },
    ] as const;
    expect(permissionChoices([...lying])).toEqual([
      {
        value: "a",
        label: "Refuser",
        description: "Autorisé sans redemander pour ce genre d'action",
      },
      {
        value: "b",
        label: "Autoriser une fois",
        description: "L'agent ne le fait pas et continue autrement",
      },
    ]);
  });

  it("writes the answers as one message", () => {
    const one = [{ question: "Quoi ?", options: ["A", "B"] }];
    expect(answerText(one, [{ picks: ["A"], text: " et C " }])).toBe("A, et C");
    expect(
      answerText(
        [...one, { question: "Où ?", options: ["X", "Y"] }],
        [{ picks: ["A"] }, { picks: [], text: "Ici" }],
      ),
    ).toBe("Quoi ? A\nOù ? Ici");
  });

  it("maps keys to what they do", () => {
    expect(cardKey("2", 4, 1)).toEqual({ do: "pick", index: 1 });
    expect(cardKey("5", 4, 1)).toBeUndefined();
    expect(cardKey("ArrowDown", 4, 1)).toEqual({ do: "move", by: 1 });
    expect(cardKey("ArrowRight", 4, 1)).toBeUndefined();
    expect(cardKey("ArrowLeft", 4, 3)).toEqual({ do: "page", by: -1 });
    expect(cardKey("Enter", 4, 1)).toEqual({ do: "confirm" });
    expect(cardKey("Escape", 4, 1)).toEqual({ do: "fold" });
    expect(cardKey("a", 4, 1)).toBeUndefined();
  });
});
