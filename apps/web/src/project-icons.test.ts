import { MAX_PROJECT_ICON } from "@moonagentic/protocol";
import { describe, expect, it } from "vitest";
import {
  findProjectIcons,
  PROJECT_ICON_PREFIX,
  PROJECT_ICONS,
  PROJECT_SPRITE,
  projectIconName,
} from "./project-icons.ts";

describe("project icons", () => {
  it("offers many icons, each kept within the size of a project's icon", () => {
    const names = Object.keys(PROJECT_ICONS);
    expect(names.length).toBeGreaterThanOrEqual(100);
    for (const name of names) {
      expect((PROJECT_ICON_PREFIX + name).length).toBeLessThanOrEqual(MAX_PROJECT_ICON);
      expect(name).toMatch(/^[a-z0-9]+$/);
    }
    expect(PROJECT_SPRITE.match(/<symbol /g)).toHaveLength(names.length);
  });

  it("reads a drawn icon back, never an emoji, letters or an unknown name", () => {
    expect(projectIconName("i:rocket")).toBe("rocket");
    expect(projectIconName("i:nothing")).toBeUndefined();
    expect(projectIconName("i:toString")).toBeUndefined();
    expect(projectIconName("🚀")).toBeUndefined();
    expect(projectIconName("AB")).toBeUndefined();
    expect(projectIconName(undefined)).toBeUndefined();
  });

  it("finds icons by their French name, without accents, or by their own name", () => {
    expect(findProjectIcons("cle")).toContain("key");
    expect(findProjectIcons("Fusée")).toEqual(["rocket"]);
    expect(findProjectIcons("database")).toContain("database");
    expect(findProjectIcons("  ")).toHaveLength(Object.keys(PROJECT_ICONS).length);
    expect(findProjectIcons("zzz")).toEqual([]);
  });
});
