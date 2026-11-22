import { describe, expect, it } from "vitest";
import { mcpServerInput, splitCommandLine } from "./mcp-input.ts";

describe("splitCommandLine", () => {
  it("keeps quoted words together", () => {
    expect(splitCommandLine(` npx -y "@scope/server x" 'a b' c"d e"f "" `)).toEqual([
      "npx",
      "-y",
      "@scope/server x",
      "a b",
      "cd ef",
      "",
    ]);
  });

  it("refuses a quote left open", () => {
    expect(() => splitCommandLine(`npx "srv x`)).toThrow("guillemet");
  });
});

describe("mcpServerInput", () => {
  it("reads a command with environment secrets", () => {
    expect(mcpServerInput("gh", "npx -y srv", "GITHUB_TOKEN = abc=def\n\n")).toEqual({
      name: "gh",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "srv"],
        env: [{ name: "GITHUB_TOKEN", value: "abc=def" }],
      },
    });
  });

  it("reads a URL with header secrets, and never echoes a secret in its errors", () => {
    expect(mcpServerInput("web", "https://x.dev/mcp", "Authorization: Bearer a:b")).toEqual({
      name: "web",
      transport: {
        type: "http",
        url: "https://x.dev/mcp",
        headers: [{ name: "Authorization", value: "Bearer a:b" }],
      },
    });
    expect(() => mcpServerInput("web", "https://x.dev", "tok3n")).toThrow(/^(?!.*tok3n)/);
  });

  it("refuses an address the server would reject", () => {
    for (const url of ["https://", "https://mon serveur/mcp"]) {
      expect(() => mcpServerInput("web", url, "")).toThrow("adresse");
    }
  });

  it("accepts lines pasted with export, and refuses bad or repeated names by line number", () => {
    expect(mcpServerInput("gh", "srv", "export GITHUB_TOKEN=abc").transport).toMatchObject({
      env: [{ name: "GITHUB_TOKEN", value: "abc" }],
    });
    const cases: [string, string, RegExp][] = [
      ["srv", "MON TOKEN=s3cret", /^Secret ligne 1 : le nom/],
      ["srv", "A=1\nB=2\nA=s3cret", /^Secret ligne 3 : même nom qu'à la ligne 1/],
      ["https://x.dev", "X Token: s3cret", /^Secret ligne 1 : un nom d'en-tête/],
      ["https://x.dev", "Authorization: a\nauthorization: s3cret", /^Secret ligne 2 : même nom/],
    ];
    for (const [target, secrets, error] of cases) {
      expect(() => mcpServerInput("x", target, secrets)).toThrow(error);
      expect(() => mcpServerInput("x", target, secrets)).toThrow(/^(?!.*s3cret)/);
    }
  });
});
