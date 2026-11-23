import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_TIMEOUT_MS,
  Connection,
  NOT_SENT,
  PING_MS,
  PONG_TIMEOUT_MS,
  readToken,
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

  closeNow(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006 });
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

describe("readToken", () => {
  it("reads the token from #token= and strips it from the URL fragment", () => {
    const saved: [string, string][] = [];
    const replaced: string[] = [];
    vi.stubGlobal("location", { href: "http://127.0.0.1:4747/reglages/remote#token=frag-123&k=v" });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (k: string, v: string) => saved.push([k, v]),
    });
    vi.stubGlobal("history", {
      state: null,
      replaceState: (_s: unknown, _t: string, url: URL) => replaced.push(url.href),
    });
    expect(readToken()).toBe("frag-123");
    expect(saved).toEqual([["moonagentic.token", "frag-123"]]);
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
    expect(readToken()).toBe("old-456");
    expect(replaced).toEqual(["http://127.0.0.1:4747/"]);
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

    await expect(
      conn.ask({ type: "search", requestId: "req-offline", query: "w" }),
    ).rejects.toThrow(NOT_SENT);
    expect(vi.getTimerCount()).toBe(0);
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
});
