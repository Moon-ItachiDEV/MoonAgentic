import type { GithubDeviceCode, GithubRepo, GithubVault } from "@moonagentic/protocol";
import type { TokenVault } from "./github-vault.ts";

/**
 * MoonAgentic's own GitHub app, made by its author for « Se connecter à GitHub ». A client id
 * is public: it names the app on GitHub's sign-in page and proves nothing by itself.
 */
export const GITHUB_CLIENT_ID = "Ov23liWxSjhPeMftaNXC";
/** Private repositories, organisations' repositories, and pushes that touch workflows. */
const SCOPES = "repo read:org workflow";
const ASK_TIMEOUT_MS = 20_000;
/** At most this many repositories are listed, last pushed first. */
const MAX_REPOS = 300;
/** How long the account GitHub confirmed is trusted before asking again. */
const RECHECK_MS = 10 * 60_000;

export interface GithubAccountOptions {
  vault: TokenVault;
  clientId?: string;
  /** github.com, or a stand-in for tests. */
  webUrl?: string;
  /** api.github.com, or a stand-in for tests. */
  apiUrl?: string;
  /** Told when a sign-in started here ends, however it ends. */
  onLogin?: (result: LoginResult) => void;
}

export type LoginResult =
  { state: "done"; login: string } | { state: "failed"; error: string } | { state: "cancelled" };

interface Flow extends GithubDeviceCode {
  deviceCode: string;
  timer?: NodeJS.Timeout;
}

/** What GitHub says when a token no longer works: it was revoked, or the app was removed. */
class Unauthorized extends Error {}

/** A GraphQL question GitHub could not answer, with its kind: NOT_FOUND, FORBIDDEN… */
export class GithubQueryError extends Error {
  readonly type: string | undefined;
  constructor(message: string, type: string | undefined) {
    super(message);
    this.type = type;
  }
}

async function asJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * MoonAgentic signed in to GitHub by itself, with GitHub's device flow: the user types a short
 * code on github.com, and the token GitHub gives back is kept in the system's vault, never sent
 * to a browser or a phone.
 */
export class GithubAccount {
  private readonly vault: TokenVault;
  private readonly clientId: string;
  private readonly webUrl: string;
  private readonly apiUrl: string;
  private readonly onLogin: (result: LoginResult) => void;
  /** Undefined until read from the vault; null when there is none. */
  private token: string | null | undefined;
  private loading: Promise<string | null> | undefined;
  private login: string | undefined;
  /** The account's number and the name on its profile, as GitHub gave them with its login. */
  private userId: number | undefined;
  private profileName: string | undefined;
  /** When GitHub last confirmed the account, so a token revoked there is noticed. */
  private checkedAt = 0;
  /** Bumped by each sign-in and sign-out, so a slow vault read never undoes one. */
  private generation = 0;
  private flow: Flow | undefined;
  /** A sign-in being started, so two devices asking at once share it. */
  private starting: Promise<GithubDeviceCode> | undefined;

  constructor(options: GithubAccountOptions) {
    this.vault = options.vault;
    this.clientId = options.clientId ?? GITHUB_CLIENT_ID;
    this.webUrl = (options.webUrl ?? "https://github.com").replace(/\/+$/, "");
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.onLogin = options.onLogin ?? (() => {});
  }

  get vaultKind(): GithubVault {
    return this.vault.kind;
  }

  get canSignIn(): boolean {
    return !!this.clientId;
  }

  /**
   * The token, read once from the vault. A vault that cannot be read now (PowerShell slow to
   * start, say) counts as none this time and is read again next time.
   */
  async currentToken(): Promise<string | undefined> {
    if (this.token === undefined) {
      const generation = this.generation;
      this.loading ??= this.vault.read().then(
        (t) => t ?? null,
        () => undefined as unknown as null,
      );
      const read = await this.loading;
      this.loading = undefined;
      if (this.generation === generation && this.token === undefined) this.token = read;
    }
    return this.token ?? undefined;
  }

  /** The token as last read, for callers that cannot wait: undefined until it was read once. */
  cachedToken(): string | undefined {
    return this.token ?? undefined;
  }

  private async api(
    pathAndQuery: string,
    token: string,
    send?: { method: string; body: unknown; accept?: string },
  ): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${pathAndQuery}`, {
      ...(send ? { method: send.method, body: JSON.stringify(send.body) } : {}),
      headers: {
        accept: send?.accept ?? "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "MoonAgentic",
        ...(send ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (response.status === 401) throw new Unauthorized("La connexion GitHub n'est plus valable.");
    if (!response.ok) {
      const body = await asJson(response);
      // A refused pull request says why in `errors`, under a bare « Validation Failed ».
      const why = [
        typeof body.message === "string" ? body.message : "",
        ...(Array.isArray(body.errors)
          ? body.errors.map((e: unknown) =>
              typeof e === "object" &&
              e !== null &&
              typeof (e as { message?: unknown }).message === "string"
                ? (e as { message: string }).message
                : "",
            )
          : []),
      ].filter(Boolean);
      throw new Error(
        `GitHub a répondu ${response.status}${why.length ? ` : ${why.join(" ; ")}` : ""}.`,
      );
    }
    return response;
  }

  private async signedIn(): Promise<string> {
    const token = await this.currentToken();
    if (!token) throw new Error("MoonAgentic n'est pas connecté à GitHub.");
    return token;
  }

  /**
   * One request to GitHub's REST API with this account: `body` sent as JSON when given. What
   * GitHub answered, read as JSON.
   */
  async rest(method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
    const token = await this.signedIn();
    try {
      const response = await this.api(
        pathAndQuery,
        token,
        body === undefined && method === "GET" ? undefined : { method, body: body ?? {} },
      );
      return await response.json();
    } catch (error) {
      return this.forgetIfRevoked(error);
    }
  }

  /**
   * One GraphQL request with this account; its `data`. GitHub answers a question it cannot
   * answer with 200 and `errors`: the first one is thrown, its `type` kept (NOT_FOUND, say).
   */
  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const token = await this.signedIn();
    let body: Record<string, unknown>;
    try {
      // The preview gives a pull request's `mergeStateStatus`, as it does for `gh`.
      body = await asJson(
        await this.api("/graphql", token, {
          method: "POST",
          body: { query, variables },
          accept: "application/vnd.github.merge-info-preview+json",
        }),
      );
    } catch (error) {
      return this.forgetIfRevoked(error);
    }
    const errors = Array.isArray(body.errors) ? (body.errors as Record<string, unknown>[]) : [];
    if (errors.length) {
      const first = errors[0] ?? {};
      throw new GithubQueryError(
        typeof first.message === "string" ? first.message : "GitHub a refusé la requête.",
        typeof first.type === "string" ? first.type : undefined,
      );
    }
    return body.data;
  }

  /** A token GitHub refuses is forgotten, so the user is asked to sign in again. */
  private async forgetIfRevoked(error: unknown): Promise<never> {
    if (error instanceof Unauthorized) {
      this.generation++;
      this.token = null;
      this.login = undefined;
      await this.vault.clear().catch(() => {});
    }
    throw error;
  }

  /**
   * The signed-in account, confirmed by GitHub every few minutes; undefined when MoonAgentic is
   * not signed in. Offline, the account last confirmed still counts: only GitHub saying no
   * signs the user out.
   */
  async account(): Promise<{ login: string } | undefined> {
    const token = await this.currentToken();
    if (!token) return undefined;
    if (this.login && Date.now() - this.checkedAt < RECHECK_MS) return { login: this.login };
    try {
      const body = await asJson(await this.api("/user", token));
      if (typeof body.login !== "string") throw new Error("GitHub n'a pas donné le compte.");
      this.login = body.login;
      this.userId = typeof body.id === "number" ? body.id : undefined;
      this.profileName =
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
      this.checkedAt = Date.now();
      return { login: body.login };
    } catch (error) {
      if (!(error instanceof Unauthorized) && this.login) return { login: this.login };
      return this.forgetIfRevoked(error);
    }
  }

  /**
   * Who signs a commit made with this account, for a computer where git was never told: the
   * name on its GitHub profile, else its login, and the address GitHub keeps for it, which
   * shows none of the user's own and ties the commit to the account. Undefined when
   * MoonAgentic is not signed in, or GitHub has not said who the account is yet.
   */
  async identity(): Promise<{ name: string; email: string } | undefined> {
    const account = await this.account();
    if (!account || this.userId === undefined) return undefined;
    return {
      name: this.profileName ?? account.login,
      email: `${this.userId}+${account.login}@users.noreply.github.com`,
    };
  }

  /** The repositories the account can reach, last pushed first. */
  async repos(): Promise<GithubRepo[]> {
    const token = await this.currentToken();
    if (!token) throw new Error("MoonAgentic n'est pas connecté à GitHub.");
    const repos: GithubRepo[] = [];
    try {
      for (let page = 1; repos.length < MAX_REPOS; page++) {
        const response = await this.api(
          `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
          token,
        );
        const list = (await response.json()) as {
          full_name: string;
          private: boolean;
          description: string | null;
          pushed_at: string | null;
        }[];
        for (const r of list) {
          repos.push({
            fullName: r.full_name,
            private: r.private,
            ...(r.description ? { description: r.description } : {}),
            ...(r.pushed_at ? { pushedAt: Date.parse(r.pushed_at) } : {}),
          });
        }
        if (list.length < 100 || !/rel="next"/.test(response.headers.get("link") ?? "")) break;
      }
    } catch (error) {
      return this.forgetIfRevoked(error);
    }
    return repos.slice(0, MAX_REPOS);
  }

  private async post(pathname: string, body: Record<string, string>) {
    const response = await fetch(`${this.webUrl}${pathname}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "MoonAgentic",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    const json = await asJson(response);
    if (!response.ok && !json.error) {
      throw new Error(`GitHub a répondu ${response.status} à la connexion.`);
    }
    return json;
  }

  /**
   * Starts a sign-in, or gives back the one still waiting, so a phone and a computer asking at
   * once see the same code. GitHub is then asked every few seconds whether the user said yes.
   */
  async startLogin(): Promise<GithubDeviceCode> {
    if (!this.clientId) throw new Error("Cette version de MoonAgentic n'a pas d'appli GitHub.");
    const waiting = this.flow;
    if (waiting && waiting.expiresAt > Date.now() + 30_000) return publicCode(waiting);
    this.starting ??= this.newLogin().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async newLogin(): Promise<GithubDeviceCode> {
    this.stopFlow();
    const body = await this.post("/login/device/code", { client_id: this.clientId, scope: SCOPES });
    if (typeof body.device_code !== "string" || typeof body.user_code !== "string") {
      throw new Error(
        body.error === "device_flow_disabled"
          ? "La connexion par code n'est pas activée sur l'appli GitHub de MoonAgentic."
          : `GitHub a refusé la connexion${typeof body.error_description === "string" ? ` : ${body.error_description}` : "."}`,
      );
    }
    const flow: Flow = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri:
        typeof body.verification_uri === "string"
          ? body.verification_uri
          : `${this.webUrl}/login/device`,
      expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
    };
    this.flow = flow;
    this.poll(flow, (Number(body.interval) || 5) * 1000);
    return publicCode(flow);
  }

  /** Asks GitHub again after `delayMs`, then every `intervalMs`. */
  private poll(flow: Flow, intervalMs: number, delayMs = intervalMs) {
    flow.timer = setTimeout(() => void this.check(flow, intervalMs), delayMs);
    flow.timer.unref?.();
  }

  private finish(flow: Flow, result: LoginResult) {
    if (this.flow !== flow) return;
    this.flow = undefined;
    this.onLogin(result);
  }

  private async check(flow: Flow, intervalMs: number) {
    if (this.flow !== flow) return;
    if (Date.now() > flow.expiresAt) {
      this.finish(flow, { state: "failed", error: "Le code a expiré. Recommence la connexion." });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await this.post("/login/oauth/access_token", {
        client_id: this.clientId,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch {
      // The network went away for a moment: ask again a bit later.
      if (this.flow === flow) this.poll(flow, intervalMs, Math.min(intervalMs * 2, 60_000));
      return;
    }
    if (this.flow !== flow) return;
    if (typeof body.access_token === "string") {
      try {
        await this.vault.write(body.access_token);
        this.generation++;
        this.token = body.access_token;
        this.login = undefined;
        // Signed in even if GitHub cannot say who right now: the status asks again later.
        const account = await this.account().catch(() => undefined);
        this.finish(flow, { state: "done", login: account?.login ?? "" });
      } catch (error) {
        this.finish(flow, {
          state: "failed",
          error: `La connexion n'a pas pu être gardée : ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    switch (body.error) {
      case "authorization_pending":
        this.poll(flow, intervalMs);
        return;
      case "slow_down":
        this.poll(flow, (Number(body.interval) || intervalMs / 1000 + 5) * 1000);
        return;
      case "access_denied":
        this.finish(flow, { state: "failed", error: "Connexion refusée sur GitHub." });
        return;
      case "expired_token":
        this.finish(flow, { state: "failed", error: "Le code a expiré. Recommence la connexion." });
        return;
      default:
        this.finish(flow, {
          state: "failed",
          error: `GitHub a refusé la connexion${typeof body.error_description === "string" ? ` : ${body.error_description}` : "."}`,
        });
    }
  }

  private stopFlow() {
    if (this.flow?.timer) clearTimeout(this.flow.timer);
    this.flow = undefined;
  }

  cancelLogin() {
    const flow = this.flow;
    if (!flow) return;
    clearTimeout(flow.timer);
    this.finish(flow, { state: "cancelled" });
  }

  /** Forgets the token here. It stays valid on GitHub until the user revokes the app there. */
  async logout() {
    this.stopFlow();
    this.generation++;
    this.token = null;
    this.login = undefined;
    await this.vault.clear();
  }

  /**
   * Environment that makes one git command sign in to github.com with this account, without a
   * word on its command line (where other programs could read it) or in the user's settings:
   * for github.com only, git's own helpers (Git Credential Manager) are set aside for MoonAgentic's
   * helper, which reads the token from the environment. Other hosts keep the user's helpers.
   * Empty when MoonAgentic is not signed in.
   */
  gitEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const token = this.cachedToken();
    if (!token) return {};
    const count = Number(env.GIT_CONFIG_COUNT) || 0;
    const key = "credential.https://github.com.helper";
    return {
      MOONAGENTIC_GITHUB_TOKEN: token,
      GIT_CONFIG_COUNT: String(count + 2),
      // An empty helper empties the list git built so far, for github.com only.
      [`GIT_CONFIG_KEY_${count}`]: key,
      [`GIT_CONFIG_VALUE_${count}`]: "",
      [`GIT_CONFIG_KEY_${count + 1}`]: key,
      [`GIT_CONFIG_VALUE_${count + 1}`]:
        '!f() { test "$1" = get && echo username=x-access-token && echo "password=$MOONAGENTIC_GITHUB_TOKEN"; }; f',
    };
  }

  /** Environment for the user's `gh`, so it acts as this account too. */
  ghEnv(): Record<string, string> {
    const token = this.cachedToken();
    return token ? { GH_TOKEN: token } : {};
  }
}

function publicCode(flow: Flow): GithubDeviceCode {
  return {
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
  };
}

let current: GithubAccount | undefined;

/** The account the running server uses; none in tests unless one is set. */
export function githubAccount(): GithubAccount | undefined {
  return current;
}

export function setGithubAccount(account: GithubAccount | undefined) {
  current = account;
}
