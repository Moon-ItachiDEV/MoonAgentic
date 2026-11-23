import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_TIMEOUT_MS, Connection } from "./connection.ts";

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

  closeNow(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
}

function setupConnection(options?: { askTimeoutMs?: number }) {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("location", { href: "http://127.0.0.1:4747/" });
  vi.stubGlobal("localStorage", {
    getItem: () => "secret-token",
    setItem: () => undefined,
  });
  vi.stubGlobal("history", { state: null, replaceState: () => undefined });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const conn = new Connection(options);
  const socket = FakeWebSocket.instances.at(-1)!;
  return { conn, socket };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Connection", () => {
  it("times out ask after 60 s by default and cleans up pending", async () => {
    expect(ASK_TIMEOUT_MS).toBe(60_000);
    const { conn, socket } = setupConnection();
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
    const { conn, socket } = setupConnection({ askTimeoutMs: 500 });
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
    const { conn, socket } = setupConnection({ askTimeoutMs: 1_000 });
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
    const { conn, socket } = setupConnection({ askTimeoutMs: 5_000 });
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
    const { conn } = setupConnection({ askTimeoutMs: 5_000 });

    await expect(
      conn.ask({ type: "search", requestId: "req-offline", query: "w" }),
    ).rejects.toThrow("Pas de connexion au serveur MoonAgentic.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores malformed JSON frames in onmessage without breaking the connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { conn, socket } = setupConnection({ askTimeoutMs: 1_000 });
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
