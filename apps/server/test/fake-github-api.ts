import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GithubAccount } from "../src/github-account.ts";
import type { TokenVault } from "../src/github-vault.ts";

export interface ApiCall {
  method: string;
  path: string;
  auth?: string;
  /** For /graphql: the query and its variables. Else the JSON body sent. */
  query?: string;
  variables?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/** What the stand-in answers: a status and a body, or a body alone (200). */
export type ApiAnswer = unknown | { status: number; body: unknown };

/**
 * A stand-in for api.github.com: each request is kept and answered by `answer`. GraphQL
 * answers are bodies as GitHub sends them, `data` or `errors`.
 */
export async function fakeGithubApi(answer: (call: ApiCall) => ApiAnswer) {
  const calls: ApiCall[] = [];
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    const call: ApiCall = {
      method: req.method ?? "GET",
      path: req.url ?? "",
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      ...(req.url === "/graphql" && json
        ? {
            query: String(json.query),
            variables: (json.variables ?? {}) as Record<string, unknown>,
          }
        : json
          ? { body: json }
          : {}),
    };
    calls.push(call);
    const out = answer(call);
    const full =
      typeof out === "object" && out !== null && "status" in out && "body" in out
        ? (out as { status: number; body: unknown })
        : { status: 200, body: out };
    res.statusCode = full.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(full.body ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** MoonAgentic signed in to GitHub with `token`, against the stand-in at `apiUrl`. */
export function signedInAccount(apiUrl: string, token = "gho_test"): GithubAccount {
  let value: string | undefined = token;
  const vault: TokenVault = {
    kind: "file",
    read: async () => value,
    write: async (t) => {
      value = t;
    },
    clear: async () => {
      value = undefined;
    },
  };
  return new GithubAccount({ vault, apiUrl, webUrl: apiUrl });
}

/** A pull request as GitHub's GraphQL API gives it for the fields MoonAgentic asks. */
export function graphqlPull(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    url: "https://github.com/moon/demo/pull/42",
    title: "Donne la réponse",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    headRefName: "feature",
    isCrossRepository: false,
    createdAt: "2026-11-27T10:00:00Z",
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    author: { login: "moon" },
    commits: { nodes: [] },
    ...over,
  };
}
