import { afterEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_FRAME_MS } from "./frame.ts";
import {
  ASK_TIMEOUT_MS,
  askTimeoutFor,
  CONFIRM_MS,
  Connection,
  DEVICE_REMOVED,
  NOT_SENT,
  PING_MS,
  PONG_TIMEOUT_MS,
  readTokens,
  TICKET_TIMEOUT_MS,
  WAKE_PONG_MS,
} from "./connection.ts";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: URL | string) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }

  close(): void {
    // A dead connection: the browser takes its time to say so.
  }

  closeNow(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

async function setupConnection(options: { askTimeoutMs?: number; pingMs?: number } = {}) {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  let tickets = 0;
  vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
  vi.stubGlobal("localStorage", {
    getItem: () => "secret-token",
    setItem: () => undefined,
  });
  vi.stubGlobal("history", { state: null, replaceState: () => undefined });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/ws-ticket") {
        tickets += 1;
        return new Response(JSON.stringify({ ticket: `ticket-${tickets}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // No heartbeat unless a test is about it: the others count the timers of a request.
  const conn = new Connection({ pingMs: 0, ...options });
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeWebSocket.instances.at(-1)!;
  return { conn, socket };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readTokens", () => {
  it("reads the token from #token=, strips it from the URL fragment and keeps nothing yet", () => {
    const saved: [string, string][] = [];
    const replaced: string[] = [];
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/reglages/remote#token=frag-123&k=v" });
    vi.stubGlobal("localStorage", {
      getItem: () => "kept-000",
      setItem: (k: string, v: string) => saved.push([k, v]),
    });
    vi.stubGlobal("history", {
      state: null,
      replaceState: (_s: unknown, _t: string, url: URL) => replaced.push(url.href),
    });
    expect(readTokens()).toEqual({ offered: "frag-123", kept: "kept-000" });
    // A link is only a claim: reading it writes nothing.
    expect(saved).toEqual([]);
    expect(replaced).toEqual(["http://127.0.0.1:4747/reglages/remote#k=v"]);
  });

  it("still accepts legacy ?token= links and scrubs them", () => {
    const replaced: string[] = [];
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/?token=old-456" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("history", {
      state: null,
      replaceState: (_s: unknown, _t: string, url: URL) => replaced.push(url.href),
    });
    expect(readTokens()).toEqual({ offered: "old-456", kept: null });
    expect(replaced).toEqual(["http://127.0.0.1:4747/"]);
  });

  it("ignores a token that could not be sent, and still takes it out of the address", () => {
    const replaced: string[] = [];
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/t/abc#token=%E2%80%AEjeton" });
    vi.stubGlobal("localStorage", { getItem: () => "kept-000", setItem: () => undefined });
    vi.stubGlobal("history", {
      state: null,
      replaceState: (_s: unknown, _t: string, url: URL) => replaced.push(url.href),
    });
    expect(readTokens()).toEqual({ offered: null, kept: "kept-000" });
    expect(replaced).toEqual(["http://127.0.0.1:4747/t/abc"]);
  });
});

/** What a tab remembers for itself, as `sessionStorage` does. */
function tabStorage(held: Record<string, string> = {}) {
  const tab = new Map(Object.entries(held));
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => tab.get(k) ?? null,
    setItem: (k: string, v: string) => void tab.set(k, v),
    removeItem: (k: string) => void tab.delete(k),
  });
  return tab;
}

describe("Connection, opened from a link that carries a token", () => {
  /**
   * A page opened at `href` on a device that kept `kept`; the server knows only `valid`.
   * `offeredBefore` is what the tab was offered by the page it showed just before.
   */
  async function openFrom(
    href: string,
    kept: string | null,
    valid: string,
    offeredBefore?: string,
  ) {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const saved: [string, string][] = [];
    const tried: string[] = [];
    const tab = tabStorage(
      offeredBefore ? { "moonagentic.token.offered": offeredBefore } : undefined,
    );
    vi.stubGlobal("location", { href });
    vi.stubGlobal("localStorage", {
      getItem: () => kept,
      setItem: (k: string, v: string) => saved.push([k, v]),
    });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
        if (input !== "/api/ws-ticket") return new Response(null, { status: 204 });
        const given = (init?.headers?.authorization ?? "").replace(/^Bearer /, "");
        tried.push(given);
        if (given !== valid) return new Response(null, { status: 401 });
        return new Response(JSON.stringify({ ticket: `ticket-for-${given}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    return { conn, saved, tried, tab };
  }

  it("keeps the link's token once the server has accepted it", async () => {
    const { conn, saved, tried, tab } = await openFrom(
      "http://127.0.0.1:4747/#token=new-token",
      "old-token",
      "new-token",
    );
    expect(tried).toEqual(["new-token"]);
    expect(saved).toEqual([["moonagentic.token", "new-token"]]);
    expect(tab.size).toBe(0);
    expect(FakeWebSocket.instances.at(-1)?.url).toContain("ticket=ticket-for-new-token");
    expect(conn.getToken()).toBe("new-token");
  });

  it("goes on with the kept token when the link's one is refused, and never keeps the refused one", async () => {
    // What an agent's answer can write: a link to the app itself with a token of its own.
    const { conn, saved, tried, tab } = await openFrom(
      "http://127.0.0.1:4747/t/abc#token=jeton-pose-par-l-agent",
      "owner-token",
      "owner-token",
    );
    expect(tried).toEqual(["jeton-pose-par-l-agent", "owner-token"]);
    expect(saved).toEqual([]);
    // Refused, it is not tried again by this tab's next page either.
    expect(tab.size).toBe(0);
    expect(conn.getState().status).not.toBe("unauthorized");
    expect(FakeWebSocket.instances.at(-1)?.url).toContain("ticket=ticket-for-owner-token");
    expect(conn.getToken()).toBe("owner-token");
  });

  it("asks to pair when the link's token is refused and nothing was kept, without keeping it", async () => {
    const { conn, saved, tried } = await openFrom(
      "http://127.0.0.1:4747/#token=wrong",
      null,
      "owner-token",
    );
    expect(tried).toEqual(["wrong"]);
    expect(saved).toEqual([]);
    expect(conn.getState().status).toBe("unauthorized");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("still has the link's token to try when the page changed before the server answered", async () => {
    // The link was opened, then another page of the app at once: the address no longer
    // holds the token, and nothing was kept yet. The tab remembers what it was offered.
    const { conn, saved, tried, tab } = await openFrom(
      "http://127.0.0.1:4747/t/abc",
      null,
      "new-token",
      "new-token",
    );
    expect(tried).toEqual(["new-token"]);
    expect(saved).toEqual([["moonagentic.token", "new-token"]]);
    expect(tab.size).toBe(0);
    expect(conn.getState().status).not.toBe("unauthorized");
  });

  it("still tries what the tab was offered when the next address holds a token that cannot be sent", async () => {
    // Such a token is no offer at all: it is taken out of the address, and takes nothing
    // away from the one this tab was waiting on.
    const { conn, saved, tried, tab } = await openFrom(
      "http://127.0.0.1:4747/t/abc#token=%E2%80%AEjeton",
      null,
      "new-token",
      "new-token",
    );
    expect(tried).toEqual(["new-token"]);
    expect(saved).toEqual([["moonagentic.token", "new-token"]]);
    expect(tab.size).toBe(0);
    expect(conn.getState().status).not.toBe("unauthorized");
  });

  it("remembers the link's token for its tab alone until the server answers", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const saved: [string, string][] = [];
    const tab = tabStorage();
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/#token=new-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => "old-token",
      setItem: (k: string, v: string) => saved.push([k, v]),
    });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    // The server takes its time: no answer yet.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    // What every tab of the device shares is untouched; this tab alone knows the offer.
    expect(saved).toEqual([]);
    expect([...tab]).toEqual([["moonagentic.token.offered", "new-token"]]);
  });

  it("keeps trying the link's token while the server cannot be reached, and keeps it only then", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const saved: [string, string][] = [];
    let reachable = false;
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/#token=new-token" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (k: string, v: string) => saved.push([k, v]),
    });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!reachable) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ticket: "ticket-1" }), { status: 200 });
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.getState().status).toBe("closed");
    expect(saved).toEqual([]);

    reachable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saved).toEqual([["moonagentic.token", "new-token"]]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("Connection heartbeat", () => {
  const sentTypes = (socket: FakeWebSocket) =>
    socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

  it("opens WebSockets with a single-use ticket and never puts the master token in the URL", async () => {
    const { socket } = await setupConnection();
    expect(socket.url).toBe("ws://127.0.0.1:4747/ws?ticket=ticket-1");
    expect(socket.url).not.toContain("secret-token");
  });

  it("marks the connection unauthorized when /api/ws-ticket returns 401", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", { getItem: () => "bad-token", setItem: () => undefined });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.getState().status).toBe("unauthorized");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("treats a non-ASCII token as unauthorized immediately without calling fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", { getItem: () => "…", setItem: () => undefined });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    expect(conn.getState().status).toBe("unauthorized");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pings while open, and opens a new connection when no answer comes", async () => {
    const { conn, socket } = await setupConnection({ pingMs: PING_MS });
    socket.open();
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(sentTypes(socket)).toEqual(["ping"]);

    // An answer in time: nothing changes.
    socket.emitMessage(JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(conn.getState().status).toBe("open");

    // The next ping gets none: the connection is given up on without waiting for the browser.
    await vi.advanceTimersByTimeAsync(PING_MS - PONG_TIMEOUT_MS + PONG_TIMEOUT_MS);
    expect(conn.getState().status).toBe("closed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The browser noticing later changes nothing.
    socket.closeNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("tries again at once when the device wakes, instead of waiting", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    // Several failures in a row: the wait has grown.
    socket.closeNow();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.instances.at(-1)!.closeNow();
    await vi.advanceTimersByTimeAsync(0);
    const before = FakeWebSocket.instances.length;

    conn.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
    FakeWebSocket.instances.at(-1)!.open();
    expect(conn.getState().status).toBe("open");

    // Awake with a connection that looks open: it is checked right away.
    conn.wake();
    expect(sentTypes(FakeWebSocket.instances.at(-1)!)).toEqual(["ping"]);
  });

  it("replaces a connection dropped while the screen was locked, as soon as the app is back", async () => {
    const { conn, socket } = await setupConnection({ pingMs: PING_MS });
    socket.open();
    // A regular ping already waits for its answer when the user comes back.
    await vi.advanceTimersByTimeAsync(PING_MS);
    conn.wake();
    expect(sentTypes(socket).filter((t) => t === "ping")).toHaveLength(2);
    // No answer: well before the usual wait, a new connection opens, without the pause
    // between tries.
    await vi.advanceTimersByTimeAsync(WAKE_PONG_MS);
    // Far less than the second the next try would otherwise wait.
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(WAKE_PONG_MS).toBeLessThan(PONG_TIMEOUT_MS);

    // A connection that answers stays.
    const next = FakeWebSocket.instances[1]!;
    next.open();
    conn.wake();
    next.emitMessage(JSON.stringify({ type: "pong" }));
    await vi.advanceTimersByTimeAsync(WAKE_PONG_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(conn.getState().status).toBe("open");
  });

  it("says when an action could not leave, and takes it back once connected again", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    socket.closeNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(conn.send({ type: "thread.cancel", threadId: "t" })).toBe(false);
    expect(conn.getState().notice).toBe(NOT_SENT);
    // Which thread is shown is told again by itself: no notice for it.
    conn.dismissNotice();
    expect(conn.send({ type: "thread.open", threadId: "t" })).toBe(false);
    expect(conn.getState().notice).toBeNull();

    conn.send({ type: "thread.cancel", threadId: "t" });
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.instances.at(-1)!.open();
    expect(conn.getState().notice).toBeNull();
  });
});

describe("Connection", () => {
  it("keeps a thread open until every part of the page that shows it has left", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    const sent = () =>
      socket.sent.map((m) => JSON.parse(m) as { type: string }).filter((m) => m.type !== "ping");
    const before = sent().length;

    // The conversation, then the team's tree, show the same thread.
    conn.send({ type: "thread.open", threadId: "t" });
    conn.send({ type: "thread.open", threadId: "t" });
    conn.send({ type: "thread.leave", threadId: "t" });
    expect(
      sent()
        .slice(before)
        .map((m) => m.type),
    ).toEqual(["thread.open", "thread.open"]);

    conn.send({ type: "thread.leave", threadId: "t" });
    expect(sent().at(-1)).toEqual({ type: "thread.leave", threadId: "t" });
  });

  it("times out ask after 60 s by default and cleans up pending", async () => {
    expect(ASK_TIMEOUT_MS).toBe(60_000);
    const { conn, socket } = await setupConnection();
    socket.open();

    const promise = conn.ask({ type: "search", requestId: "req-default", query: "test" });
    const rejected = expect(promise).rejects.toThrow(
      "Le serveur MoonAgentic n'a pas répondu à temps.",
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);

    // A late reply arriving after expiration is ignored cleanly.
    expect(() =>
      socket.emitMessage(JSON.stringify({ type: "searched", requestId: "req-default", hits: [] })),
    ).not.toThrow();
  });

  it("waits for a clone, a push or a merge as long as the server works on it", async () => {
    expect(askTimeoutFor("search")).toBe(ASK_TIMEOUT_MS);
    expect(askTimeoutFor("project.clone")).toBeGreaterThan(15 * 60_000);
    expect(askTimeoutFor("workspace.ship")).toBeGreaterThan(5 * 60_000);
    expect(askTimeoutFor("team.ship")).toBe(askTimeoutFor("workspace.ship"));
    expect(askTimeoutFor("workspace.mergePr")).toBeGreaterThan(2 * 60_000);
    // A longer usual wait is never cut short.
    expect(askTimeoutFor("workspace.mergePr", 10 * 60_000)).toBe(10 * 60_000);

    const { conn, socket } = await setupConnection();
    socket.open();
    let failed: unknown;
    const pushed = conn
      .request({
        type: "workspace.ship",
        requestId: "req-ship",
        threadId: "t1",
        message: "Corrige la réponse",
        pr: true,
        files: ["src/app.ts"],
      })
      .catch((error: unknown) => {
        failed = error;
        return undefined;
      });
    // Past the usual minute the page still waits: the push may take the server minutes.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(failed).toBeUndefined();
    socket.emitMessage(
      JSON.stringify({
        type: "shipped",
        requestId: "req-ship",
        url: "https://github.com/o/r/pull/1",
      }),
    );
    await expect(pushed).resolves.toBe("https://github.com/o/r/pull/1");
    expect(failed).toBeUndefined();
  });

  it("supports an injectable timeout on Connection and per ask call", async () => {
    const { conn, socket } = await setupConnection({ askTimeoutMs: 500 });
    socket.open();

    const p1 = conn.ask({ type: "search", requestId: "req-1", query: "a" });
    const p1Rejected = expect(p1).rejects.toThrow(
      "Le serveur MoonAgentic n'a pas répondu à temps.",
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await p1Rejected;
    expect(vi.getTimerCount()).toBe(0);

    const p2 = conn.ask({ type: "search", requestId: "req-2", query: "b" }, 150);
    const p2Rejected = expect(p2).rejects.toThrow(
      "Le serveur MoonAgentic n'a pas répondu à temps.",
    );
    await vi.advanceTimersByTimeAsync(150);
    await p2Rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout timer when a reply or error arrives", async () => {
    const { conn, socket } = await setupConnection({ askTimeoutMs: 1_000 });
    socket.open();

    const okPromise = conn.ask({ type: "search", requestId: "req-ok", query: "x" });
    expect(vi.getTimerCount()).toBe(1);
    socket.emitMessage(JSON.stringify({ type: "searched", requestId: "req-ok", hits: [] }));
    await expect(okPromise).resolves.toEqual({ type: "searched", requestId: "req-ok", hits: [] });
    expect(vi.getTimerCount()).toBe(0);

    const errPromise = conn.ask({ type: "search", requestId: "req-err", query: "y" });
    const errRejected = expect(errPromise).rejects.toThrow("Refusé");
    expect(vi.getTimerCount()).toBe(1);
    socket.emitMessage(JSON.stringify({ type: "error", requestId: "req-err", message: "Refusé" }));
    await errRejected;
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pending requests and cancels their timers when the socket closes", async () => {
    const { conn, socket } = await setupConnection({ askTimeoutMs: 5_000 });
    socket.open();

    const promise = conn.ask({ type: "search", requestId: "req-close", query: "z" });
    const rejected = expect(promise).rejects.toThrow("Connexion perdue.");
    expect(vi.getTimerCount()).toBe(1);

    socket.closeNow();
    expect(vi.getTimerCount()).toBe(0);
    await rejected;
    expect(conn.getState().status).toBe("closed");
  });

  it("rejects immediately without leaving a timer when the socket is not open", async () => {
    const { conn } = await setupConnection({ askTimeoutMs: 5_000 });
    // The connection being opened has its own wait: the ask adds none.
    const before = vi.getTimerCount();

    await expect(
      conn.ask({ type: "search", requestId: "req-offline", query: "w" }),
    ).rejects.toThrow(NOT_SENT);
    expect(vi.getTimerCount()).toBe(before);
  });

  it("ignores malformed JSON frames in onmessage without breaking the connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { conn, socket } = await setupConnection({ askTimeoutMs: 1_000 });
    socket.open();

    expect(() => socket.emitMessage("{trame invalide")).not.toThrow();
    expect(() => socket.emitMessage("null")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(conn.getState().status).toBe("open");

    const promise = conn.ask({ type: "search", requestId: "req-after", query: "ok" });
    socket.emitMessage(JSON.stringify({ type: "searched", requestId: "req-after", hits: [] }));
    await expect(promise).resolves.toEqual({ type: "searched", requestId: "req-after", hits: [] });
  });
  it("comes back to a thread with the mark of what it holds, and takes what changed", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    const sent = (s: FakeWebSocket) => s.sent.map((raw) => JSON.parse(raw) as object);
    conn.send({ type: "thread.open", threadId: "t1" });
    // Nothing held yet: the timeline is asked for.
    expect(sent(socket)).toEqual([{ type: "thread.open", threadId: "t1" }]);
    const said = (id: string, text: string) => ({ id, kind: "agent", text, at: 1 });
    socket.emitMessage(
      JSON.stringify({
        type: "items",
        threadId: "t1",
        items: [said("i8", "Huit"), said("i9", "Neuf")],
        first: 8,
        earlier: 7,
        epoch: "e1",
        rev: 3,
      }),
    );
    socket.emitMessage(
      JSON.stringify({ type: "append", threadId: "t1", itemId: "i9", text: " !", rev: 4 }),
    );

    // The connection drops and comes back: the thread is opened again from where it was.
    socket.closeNow();
    await vi.advanceTimersByTimeAsync(1_000);
    const again = FakeWebSocket.instances.at(-1)!;
    expect(again).not.toBe(socket);
    again.open();
    expect(sent(again)).toEqual([
      { type: "thread.open", threadId: "t1", since: { epoch: "e1", rev: 4, first: 8 } },
    ]);
    again.emitMessage(
      JSON.stringify({
        type: "changes",
        threadId: "t1",
        items: [{ item: said("i10", "Dix"), seq: 10 }],
        rev: 6,
      }),
    );
    const texts = conn.getState().items["t1"]!.map((i) => (i as { text: string }).text);
    expect(texts).toEqual(["Huit", "Neuf !", "Dix"]);
    expect(conn.getState().held["t1"]).toEqual({ first: 8, earlier: 7, epoch: "e1", rev: 6 });
    // Shown again later on the same connection, it is asked for the same way.
    conn.send({ type: "thread.leave", threadId: "t1" });
    conn.send({ type: "thread.open", threadId: "t1" });
    expect(sent(again).at(-1)).toEqual({
      type: "thread.open",
      threadId: "t1",
      since: { epoch: "e1", rev: 6, first: 8 },
    });
  });

  it("tells the page once per frame while an agent writes, and at once for anything else", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    const thread = { id: "t1", title: "Fil", status: "running" };
    const answer = { id: "i1", kind: "agent", text: "" };
    socket.emitMessage(
      JSON.stringify({
        type: "items",
        threadId: "t1",
        items: [answer],
        first: 1,
        earlier: 0,
        epoch: "e1",
        rev: 0,
      }),
    );
    let told = 0;
    conn.subscribe(() => (told += 1));
    const text = () => (conn.getState().items["t1"]![0] as { text: string }).text;

    for (const piece of ["Bon", "jour", " à", " toi"]) {
      socket.emitMessage(
        JSON.stringify({ type: "append", threadId: "t1", itemId: "i1", text: piece, rev: 1 }),
      );
    }
    // What was written is known at once; the page hears of it at the next frame, once.
    expect(text()).toBe("Bonjour à toi");
    expect(told).toBe(0);
    await vi.advanceTimersByTimeAsync(HIDDEN_FRAME_MS);
    expect(told).toBe(1);
    await vi.advanceTimersByTimeAsync(HIDDEN_FRAME_MS * 5);
    expect(told).toBe(1);

    // The end of the turn does not wait for a frame, and the frame it overtook says nothing more.
    socket.emitMessage(
      JSON.stringify({ type: "append", threadId: "t1", itemId: "i1", text: ".", rev: 2 }),
    );
    socket.emitMessage(JSON.stringify({ type: "thread", thread: { ...thread, status: "idle" } }));
    expect(told).toBe(2);
    expect(text()).toBe("Bonjour à toi.");
    await vi.advanceTimersByTimeAsync(HIDDEN_FRAME_MS * 5);
    expect(told).toBe(2);
  });
});

/** What a socket was given, read back. */
const sentOn = (socket: FakeWebSocket) =>
  socket.sent.map((raw) => JSON.parse(raw) as { type: string; sendId?: string; text?: string });

// Audit of 2026-11-25, N25: a phone's network changes, the connection dies without a word,
// and what the user does meanwhile was lost without them knowing.
describe("an action sent on a connection that died without a word", () => {
  it("goes again, the same, on the next connection", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    expect(conn.send({ type: "thread.send", threadId: "t", text: "Bonjour" })).toBe(true);
    const [sent, ping] = sentOn(socket);
    expect(sent).toMatchObject({ type: "thread.send", text: "Bonjour" });
    expect(sent!.sendId).toBeTruthy();
    // The server is asked at once whether it got it.
    expect(ping).toEqual({ type: "ping" });

    // No answer: the connection is replaced well before the browser would notice.
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(conn.getState().status).not.toBe("open");
    await vi.advanceTimersByTimeAsync(10);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    const again = sentOn(next).find((m) => m.type === "thread.send");
    expect(again).toEqual(sent);
  });

  it("does not go again once the server answered after it", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    conn.send({ type: "permission.respond", threadId: "t", itemId: "p", optionId: "oui" });
    const sendId = sentOn(socket)[0]!.sendId!;
    expect(conn.waitsForConfirmation(sendId)).toBe(true);
    socket.emitMessage(JSON.stringify({ type: "pong" }));
    expect(conn.waitsForConfirmation(sendId)).toBe(false);
    expect(conn.confirmedSince(sendId)).toBeTypeOf("number");
    await vi.advanceTimersByTimeAsync(CONFIRM_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);

    socket.closeNow();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.instances.at(-1)!;
    next.open();
    expect(sentOn(next).some((m) => m.type === "permission.respond")).toBe(false);
  });

  it("is not taken as received by the answer to a ping sent before it", async () => {
    const { conn, socket } = await setupConnection({ pingMs: PING_MS });
    socket.open();
    await vi.advanceTimersByTimeAsync(PING_MS);
    conn.send({
      type: "question.respond",
      threadId: "t",
      itemId: "q",
      answers: [{ picks: ["a"] }],
    });
    const sendId = sentOn(socket).find((m) => m.type === "question.respond")!.sendId!;
    // The answer to the heartbeat's ping: it left before the action.
    socket.emitMessage(JSON.stringify({ type: "pong" }));
    expect(conn.waitsForConfirmation(sendId)).toBe(true);
    socket.emitMessage(JSON.stringify({ type: "pong" }));
    expect(conn.waitsForConfirmation(sendId)).toBe(false);
  });
});

describe("a connection replaced after it died without a word", () => {
  it("opens with the ticket the server gave on it, asking for none", async () => {
    const { socket } = await setupConnection();
    socket.open();
    socket.emitMessage(JSON.stringify({ type: "ws.ticket", ticket: "spare-1", ttlMs: 60_000 }));
    const asked = vi.mocked(fetch).mock.calls.length;
    socket.closeNow();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    expect(new URL(next.url).searchParams.get("ticket")).toBe("spare-1");
    expect(vi.mocked(fetch).mock.calls.length).toBe(asked);
  });

  it("asks for one once the ticket it was given is too old, or was used", async () => {
    const { socket } = await setupConnection();
    socket.open();
    socket.emitMessage(JSON.stringify({ type: "ws.ticket", ticket: "spare-1", ttlMs: 10_000 }));
    // A little before the server stops taking it, it is not tried any more.
    await vi.advanceTimersByTimeAsync(6_000);
    socket.closeNow();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(new URL(next.url).searchParams.get("ticket")).toMatch(/^ticket-/);
    // Never twice: the one after that asks too.
    next.closeNow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(new URL(FakeWebSocket.instances.at(-1)!.url).searchParams.get("ticket")).toMatch(
      /^ticket-/,
    );
  });
});

describe("a ticket asked for on a network that went away", () => {
  it("is asked for again at once after each try that stayed silent", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", { getItem: () => "secret-token", setItem: () => undefined });
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    let asked = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            if (input !== "/api/ws-ticket") return resolve(new Response(null, { status: 204 }));
            asked += 1;
            // The first three never come back, as on connections the browser kept that died
            // with the network.
            if (asked > 3) {
              return resolve(new Response(JSON.stringify({ ticket: "t2" }), { status: 200 }));
            }
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(3 * TICKET_TIMEOUT_MS + 100);
    expect(asked).toBe(4);
    FakeWebSocket.instances.at(-1)!.open();
    expect(conn.getState().status).toBe("open");
  });
});

// Audit of 2026-11-25, N30.
describe("access taken back or renewed", () => {
  const storage = (initial: string) => {
    const kept = new Map([["moonagentic.token", initial]]);
    return {
      kept,
      store: {
        getItem: (k: string) => kept.get(k) ?? null,
        setItem: (k: string, v: string) => void kept.set(k, v),
        removeItem: (k: string) => void kept.delete(k),
      },
    };
  };

  it("says so on a device the computer removed, and still after a reload", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const { kept, store } = storage("phone-token");
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input === "/api/ws-ticket"
          ? new Response(JSON.stringify({ ticket: "t1" }), { status: 200 })
          : new Response(null, { status: 401 }),
      ),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.closeNow(4003);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.getState().status).toBe("unauthorized");
    expect(conn.pairError).toBe(DEVICE_REMOVED);
    expect(kept.has("moonagentic.token")).toBe(false);

    const reloaded = new Connection({ pingMs: 0 });
    expect(reloaded.getState().status).toBe("unauthorized");
    expect(reloaded.pairError).toBe(DEVICE_REMOVED);
  });

  it("goes on with the token another tab renewed, instead of asking to pair", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const { kept, store } = storage("old-token");
    type Listener = (event: { key: string; newValue: string | null }) => void;
    const listeners = new Map<string, Listener>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    });
    vi.stubGlobal("document", { addEventListener: () => undefined, visibilityState: "visible" });
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    const tickets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
        const token = init?.headers?.authorization?.replace("Bearer ", "") ?? "";
        if (token !== kept.get("moonagentic.token")) return new Response(null, { status: 401 });
        if (input === "/api/ws-ticket") {
          tickets.push(token);
          return new Response(JSON.stringify({ ticket: `t-${token}` }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0]!.open();

    // The other tab renews: the server closes this one, before that tab has kept the new
    // token, so this one is refused at first.
    kept.set("moonagentic.token", "new-token-pending");
    FakeWebSocket.instances[0]!.closeNow(4001);
    await vi.advanceTimersByTimeAsync(0);
    kept.set("moonagentic.token", "new-token");
    listeners.get("storage")?.({ key: "moonagentic.token", newValue: "new-token" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickets.at(-1)).toBe("new-token");
    FakeWebSocket.instances.at(-1)!.open();
    expect(conn.getState().status).toBe("open");
  });

  it("retries instead of going unauthorized when another tab renews while /api/auth is in flight", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const { kept, store } = storage("old-token");
    type Listener = (event: { key: string; newValue: string | null }) => void;
    const listeners = new Map<string, Listener>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    });
    vi.stubGlobal("document", { addEventListener: () => undefined, visibilityState: "visible" });
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    let resolveAuth: ((res: Response) => void) | undefined;
    const tickets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: { headers?: Record<string, string> }) => {
        const token = init?.headers?.authorization?.replace("Bearer ", "") ?? "";
        if (input === "/api/auth" && token === "old-token") {
          return new Promise<Response>((resolve) => {
            resolveAuth = resolve;
          });
        }
        if (input === "/api/ws-ticket") {
          tickets.push(token);
          return Promise.resolve(
            new Response(JSON.stringify({ ticket: `t-${token}` }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0]!.open();

    // Server closes with TOKEN_RENEWED; /api/auth with old-token starts and stays in flight.
    FakeWebSocket.instances[0]!.closeNow(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAuth).toBeDefined();

    // Meanwhile the other tab writes the new token and fires the storage event.
    kept.set("moonagentic.token", "new-token");
    listeners.get("storage")?.({ key: "moonagentic.token", newValue: "new-token" });

    // Now the stale /api/auth (sent with old-token) answers 401.
    resolveAuth!(new Response(null, { status: 401 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conn.getState().status).not.toBe("unauthorized");
    expect(tickets.at(-1)).toBe("new-token");
    FakeWebSocket.instances.at(-1)!.open();
    expect(conn.getState().status).toBe("open");
  });

  it("retries instead of going unauthorized when another tab renews while /api/ws-ticket is in flight", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const { kept, store } = storage("old-token");
    type Listener = (event: { key: string; newValue: string | null }) => void;
    const listeners = new Map<string, Listener>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    });
    vi.stubGlobal("document", { addEventListener: () => undefined, visibilityState: "visible" });
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    let resolveFirstTicket: ((res: Response) => void) | undefined;
    const tickets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: { headers?: Record<string, string> }) => {
        const token = init?.headers?.authorization?.replace("Bearer ", "") ?? "";
        if (input === "/api/ws-ticket") {
          tickets.push(token);
          if (token === "old-token") {
            return new Promise<Response>((resolve) => {
              resolveFirstTicket = resolve;
            });
          }
          return Promise.resolve(
            new Response(JSON.stringify({ ticket: `t-${token}` }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveFirstTicket).toBeDefined();

    // Storage updates token while the first /api/ws-ticket request is still in flight.
    kept.set("moonagentic.token", "new-token");
    listeners.get("storage")?.({ key: "moonagentic.token", newValue: "new-token" });

    // Stale /api/ws-ticket with old-token returns 401: must retry with new-token.
    resolveFirstTicket!(new Response(null, { status: 401 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.getState().status).not.toBe("unauthorized");
    expect(tickets).toEqual(["old-token", "new-token"]);
    FakeWebSocket.instances.at(-1)!.open();
    expect(conn.getState().status).toBe("open");
  });

  it("clears drafts and unconfirmed actions when a device is revoked", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const { kept, store } = storage("phone-token");
    kept.set("moonagentic.drafts", JSON.stringify({ t1: { text: "Secret", at: 1 } }));
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("history", { state: null, replaceState: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input === "/api/ws-ticket"
          ? new Response(JSON.stringify({ ticket: "t1" }), { status: 200 })
          : new Response(null, { status: 401 }),
      ),
    );
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const conn = new Connection({ pingMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const s1 = FakeWebSocket.instances[0]!;
    s1.open();
    conn.send({ type: "thread.send", threadId: "t1", text: "Avant révocation" });
    const sendId = sentOn(s1)[0]!.sendId!;
    expect(conn.waitsForConfirmation(sendId)).toBe(true);

    s1.closeNow(4003);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.getState().status).toBe("unauthorized");
    expect(kept.has("moonagentic.drafts")).toBe(false);
    expect(conn.waitsForConfirmation(sendId)).toBe(false);
  });
});

describe("confirmation timer and stale socket guards", () => {
  it("resets the confirmation deadline for a second action when the first is confirmed", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    conn.send({ type: "thread.send", threadId: "t", text: "Un" });
    const firstId = sentOn(socket)[0]!.sendId!;

    await vi.advanceTimersByTimeAsync(CONFIRM_MS - 500);
    conn.send({ type: "thread.send", threadId: "t", text: "Deux" });
    const secondId = sentOn(socket).find((m) => m.text === "Deux")!.sendId!;

    // First pong arrives 100ms before the original deadline: second action must get a full window.
    await vi.advanceTimersByTimeAsync(400);
    socket.emitMessage(JSON.stringify({ type: "pong" }));
    expect(conn.waitsForConfirmation(firstId)).toBe(false);
    expect(conn.waitsForConfirmation(secondId)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(conn.getState().status).toBe("open");

    // Once the full window expires without the second pong, reconnect replays only the second action.
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1]!;
    next.open();
    const replayed = sentOn(next).filter((m) => m.type === "thread.send");
    expect(replayed.map((m) => m.text)).toEqual(["Deux"]);
  });

  it("replays thread.setArchived and thread.send in order after a silent drop", async () => {
    const { conn, socket } = await setupConnection();
    socket.open();
    conn.send({ type: "thread.setArchived", threadId: "t", archived: false });
    conn.send({ type: "thread.send", threadId: "t", text: "Relance" });

    await vi.advanceTimersByTimeAsync(CONFIRM_MS + 10);
    const next = FakeWebSocket.instances.at(-1)!;
    expect(next).not.toBe(socket);
    next.open();
    const replayed = sentOn(next).filter((m) => m.type !== "ping");
    expect(replayed.map((m) => m.type)).toEqual(["thread.setArchived", "thread.send"]);
  });

  it("ignores a late onopen from a socket already replaced after OPEN_TIMEOUT_MS", async () => {
    const { conn, socket } = await setupConnection();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(conn.getState().status).toBe("closed");

    // Stale socket finishes opening late: must be ignored and not flip state to open.
    socket.open();
    expect(conn.getState().status).toBe("closed");
  });

  it("forgets local drafts when threads or projects are removed", async () => {
    const kept = new Map<string, string>([
      ["moonagentic.token", "secret-token"],
      [
        "moonagentic.drafts",
        JSON.stringify({
          t1: { text: "Brouillon 1", at: 1 },
          t2: { text: "Brouillon 2", at: 2 },
          t3: { text: "Brouillon 3", at: 3 },
        }),
      ],
    ]);
    const { socket } = await setupConnection();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    });
    socket.open();
    socket.emitMessage(
      JSON.stringify({
        type: "snapshot",
        snapshot: {
          projects: [{ id: "p1", name: "P1", path: "/p1", git: false }],
          threads: [
            { id: "t1", projectId: "p1", title: "T1", status: "idle" },
            { id: "t2", projectId: "p1", title: "T2", status: "idle" },
            { id: "t3", projectId: "p2", title: "T3", status: "idle" },
          ],
          agents: [],
          requests: [],
          questions: [],
          plan: [],
          schedules: [],
        },
      }),
    );

    socket.emitMessage(JSON.stringify({ type: "threadRemoved", threadId: "t1" }));
    expect(Object.keys(JSON.parse(kept.get("moonagentic.drafts")!) as object).sort()).toEqual([
      "t2",
      "t3",
    ]);

    socket.emitMessage(JSON.stringify({ type: "projectRemoved", projectId: "p1" }));
    expect(Object.keys(JSON.parse(kept.get("moonagentic.drafts")!) as object)).toEqual(["t3"]);
  });
});
