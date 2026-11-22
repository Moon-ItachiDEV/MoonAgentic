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
});
