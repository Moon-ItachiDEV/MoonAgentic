import { describe, expect, it } from "vitest";
import { readPlan } from "../src/team.ts";

describe("readPlan", () => {
  it("reads the last json block of the lead's reply", () => {
    const reply =
      'Un exemple :\n```json\n{"tasks": [{"title": "x", "brief": "y"}]}\n```\nLe plan :\n```json\n{"tasks": [{"title": "A", "brief": "Fais A"}, {"title": "B", "brief": "Fais B"}]}\n```';
    expect(readPlan(reply)).toEqual([
      { title: "A", brief: "Fais A" },
      { title: "B", brief: "Fais B" },
    ]);
  });

  it("takes a plan without its fence, and drops pieces that lack a title or a brief", () => {
    expect(
      readPlan(
        'Voici : {"tasks": [{"title": "A", "brief": "Fais A"}, {"title": "", "brief": "?"}, {"brief": "x"}]}',
      ),
    ).toEqual([{ title: "A", brief: "Fais A" }]);
  });

  it("reads a bare plan laid out on several lines, with text after it, and a ```JSON fence", () => {
    const plan = [{ title: "A", brief: 'Fais "A" {vite}' }];
    expect(
      readPlan(
        `Le plan :\n{\n  "tasks": [\n    {"title": "A", "brief": "Fais \\"A\\" {vite}"}\n  ]\n}\nBon courage !`,
      ),
    ).toEqual(plan);
    expect(readPlan(`{ "tasks" : [{"title": "A", "brief": "Fais \\"A\\" {vite}"}] } fin`)).toEqual(
      plan,
    );
    expect(readPlan('```JSON\n{"tasks": [{"title": "B", "brief": "Fais B"}]}\n```')).toEqual([
      { title: "B", brief: "Fais B" },
    ]);
  });

  it("finds no plan in prose or broken json, and keeps eight pieces at most", () => {
    expect(readPlan("Je préfère ne pas faire de plan.")).toBeUndefined();
    expect(readPlan('```json\n{"tasks": [\n```')).toBeUndefined();
    const many = { tasks: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, brief: "b" })) };
    expect(readPlan("```json\n" + JSON.stringify(many) + "\n```")).toHaveLength(8);
  });
});
