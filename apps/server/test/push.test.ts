// Web Push: what is encrypted and signed, for whom, and when it is sent.
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage, Thread } from "@moonagentic/protocol";
import { Agents } from "../src/agents.ts";
import { Hub } from "../src/hub.ts";
import {
  encryptPayload,
  knownPushService,
  MAX_PAYLOAD,
  MAX_SUBSCRIPTIONS,
  Push,
  type PushSend,
  vapidAuthorization,
  vapidKeys,
} from "../src/push.ts";
import { Store } from "../src/store.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-push-"));
  const s = new Store(path.join(dir, "state.sqlite"));
  cleanups.push(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}

/** A browser's side: its keys, and how it reads what it receives. */
function browser() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  const hmac = (key: Buffer, ...data: Buffer[]) => {
    const h = createHmac("sha256", key);
    for (const d of data) h.update(d);
    return h.digest();
  };
  return {
    p256dh: publicKey.toString("base64url"),
    auth: auth.toString("base64url"),
    /** RFC 8291, read the other way. */
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16);
      expect(body.readUInt32BE(16)).toBe(4096);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const prkKey = hmac(auth, shared);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, asPublic]);
      const ikm = hmac(prkKey, info, Buffer.from([1]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1]));
      const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1]));
      const sealed = body.subarray(21 + idlen);
      const decipher = createDecipheriv("aes-128-gcm", cek.subarray(0, 16), nonce.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
      expect(plain[plain.length - 1]).toBe(2);
      return plain.subarray(0, -1).toString();
    },
  };
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

/** A push service that keeps what it receives and answers with `status`. */
function service(status = 201) {
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  let answer = status;
  const send: PushSend = async (url, init) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: Buffer.from(init.body as Uint8Array),
    });
    return { status: answer };
  };
  return { sent, send, answer: (s: number) => void (answer = s) };
}

const thread = (over: Partial<Thread> = {}) =>
  ({
    id: "t1",
    projectId: "p1",
    title: "Refaire l'accueil",
    status: "running",
    ...over,
  }) as Thread;

describe("web push", () => {
  it("writes only to the known push services", () => {
    for (const ok of [
      ENDPOINT,
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/QAbc",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(knownPushService(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://push.apple.com/x",
      "https://xpush.apple.com/x",
      "pas une adresse",
    ]) {
      expect(knownPushService(bad), bad).toBe(false);
    }
  });

  it("encrypts a message the browser alone can read", () => {
    const b = browser();
    const body = encryptPayload(Buffer.from('{"title":"Attend ta réponse"}'), b.p256dh, b.auth);
    expect(b.decrypt(body)).toBe('{"title":"Attend ta réponse"}');
    // Each message has its own salt and key: two of the same differ.
    expect(encryptPayload(Buffer.from("x"), b.p256dh, b.auth)).not.toEqual(
      encryptPayload(Buffer.from("x"), b.p256dh, b.auth),
    );
    expect(() => encryptPayload(Buffer.from("x"), "abc", b.auth)).toThrow(/invalides/);
  });

  it("gives what RFC 8291's own example gives", () => {
    const b = (text: string) => Buffer.from(text, "base64url");
    const body = encryptPayload(
      b("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      {
        salt: b("DGv6ra1nlYgDCS1FRnbzlw"),
        asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("keeps its key pair, and signs for each push service", () => {
    const s = store();
    const keys = vapidKeys(s);
    expect(vapidKeys(s).publicKey).toBe(keys.publicKey);
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    const now = Date.UTC(2026, 10, 23);
    const header = vapidAuthorization(ENDPOINT, keys, now);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, sig] = jwt!.split(".");
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 3600,
      sub: "https://github.com/Moon-ItachiDEV/MoonAgentic",
    });
    const raw = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    const signed = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sig!, "base64url"),
    );
    expect(signed).toBe(true);
  });

  it("sends a thread's notice to each browser, but those quiet about its project", async () => {
    const s = store();
    const svc = service();
    const push = new Push(s, { send: svc.send });
    const phone = browser();
    const tablet = browser();
    push.subscribe({ endpoint: ENDPOINT, ...phone, muted: [] }, "telephone");
    push.subscribe(
      { endpoint: "https://web.push.apple.com/tablette", ...tablet, muted: ["p1"] },
      "tablette",
    );
    push.know([thread()]);
    push.threadChanged(thread({ summary: "rien de neuf" }));
    expect(svc.sent).toEqual([]);
    push.threadChanged(thread({ status: "waiting" }));
    await expect.poll(() => svc.sent.length).toBe(1);
    const [sent] = svc.sent;
    expect(sent!.url).toBe(ENDPOINT);
    expect(sent!.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      ttl: "86400",
      urgency: "high",
    });
    expect(sent!.headers.authorization).toMatch(/^vapid t=/);
    expect(sent!.headers.topic).toMatch(/^[\w-]{1,32}$/);
    expect(JSON.parse(phone.decrypt(sent!.body))).toEqual({
      title: "Attend ta réponse",
      body: "Refaire l'accueil",
      tag: "t1:waiting",
      threadId: "t1",
    });
    // A thread seen for the first time owes nothing.
    push.threadChanged(thread({ id: "t2", status: "waiting" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(svc.sent).toHaveLength(1);
  });

  it("keeps a message within one record, a long title cut", async () => {
    const b = browser();
    expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD), b.p256dh, b.auth)).not.toThrow();
    expect(encryptPayload(Buffer.alloc(MAX_PAYLOAD), b.p256dh, b.auth)).toHaveLength(4096);
    expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD + 1), b.p256dh, b.auth)).toThrow(/long/);
    const s = store();
    const svc = service();
    const push = new Push(s, { send: svc.send });
    push.subscribe({ endpoint: ENDPOINT, ...b, muted: [] }, undefined);
    await push.deliver(
      { tag: "t:waiting", threadId: "t", title: "a", body: "é".repeat(5000) },
      "p",
    );
    const sent = JSON.parse(b.decrypt(svc.sent[0]!.body)) as { body: string };
    expect(sent.body).toHaveLength(200);
    expect(sent.body.endsWith("…")).toBe(true);
  });

  it("forgets the computer's browsers when asked, and leaves the devices'", () => {
    const s = store();
    const push = new Push(s, { send: service().send });
    const b = browser();
    push.subscribe({ endpoint: ENDPOINT, ...b, muted: [] }, undefined);
    push.subscribe({ endpoint: `${ENDPOINT}-tel`, ...b, muted: [] }, "telephone");
    push.forget((deviceId) => deviceId === undefined);
    expect(s.listPushSubscriptions().map((r) => r.endpoint)).toEqual([`${ENDPOINT}-tel`]);
  });

  it("forgets a browser the push service says is gone", async () => {
    const s = store();
    const svc = service(410);
    const push = new Push(s, { send: svc.send });
    push.subscribe({ endpoint: ENDPOINT, ...browser(), muted: [] }, undefined);
    await push.deliver({ tag: "t:waiting", threadId: "t", title: "a", body: "b" }, "p");
    expect(s.listPushSubscriptions()).toEqual([]);
  });

  it("refuses an unknown service, bad keys, too many browsers; forgets only its own", () => {
    const s = store();
    const push = new Push(s, { send: service().send });
    const b = browser();
    expect(() =>
      push.subscribe({ endpoint: "https://127.0.0.1/x", ...b, muted: [] }, undefined),
    ).toThrow(/pas reconnu/);
    expect(() =>
      push.subscribe({ endpoint: ENDPOINT, p256dh: "x", auth: b.auth, muted: [] }, undefined),
    ).toThrow(/invalides/);
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      push.subscribe({ endpoint: `${ENDPOINT}${i}`, ...b, muted: [] }, `d${i}`);
    }
    expect(() => push.subscribe({ endpoint: `${ENDPOINT}x`, ...b, muted: [] }, undefined)).toThrow(
      /Déjà/,
    );
    // Said again by the same browser: replaced, not added.
    push.subscribe({ endpoint: `${ENDPOINT}0`, ...b, muted: ["p1"] }, "d0");
    expect(s.listPushSubscriptions()).toHaveLength(MAX_SUBSCRIPTIONS);
    expect(push.subscribed(`${ENDPOINT}0`, "d0")).toBe(true);
    expect(push.subscribed(`${ENDPOINT}0`, "d1")).toBe(false);
    push.unsubscribe(`${ENDPOINT}0`, "d1");
    expect(push.subscribed(`${ENDPOINT}0`, "d0")).toBe(true);
    push.unsubscribe(`${ENDPOINT}0`, "d0");
    expect(push.subscribed(`${ENDPOINT}0`, "d0")).toBe(false);
  });

  it("forgets a revoked device's browsers", () => {
    const s = store();
    const push = new Push(s, { send: service().send });
    const b = browser();
    s.addDevice({ id: "d1", name: "Téléphone", tokenHash: "h", createdAt: 1, lastSeen: 1 });
    push.subscribe({ endpoint: ENDPOINT, ...b, muted: [] }, "d1");
    push.subscribe({ endpoint: `${ENDPOINT}-pc`, ...b, muted: [] }, undefined);
    expect(s.removeDevice("d1")).toBe(true);
    expect(s.listPushSubscriptions().map((r) => r.endpoint)).toEqual([`${ENDPOINT}-pc`]);
  });

  it("is sent by the hub when a thread starts waiting for an answer", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-push-hub-"));
    mkdirSync(path.join(dir, ".home"));
    const s = new Store(path.join(dir, "state.sqlite"));
    const svc = service();
    const hub = new Hub(s, new Agents({ demo: true }), {
      worktreesDir: path.join(dir, ".worktrees"),
      homeDir: path.join(dir, ".home"),
      pushSend: svc.send,
    });
    cleanups.push(async () => {
      await hub.close();
      s.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const replies: ServerMessage[] = [];
    const phone = { send: (m: ServerMessage) => void replies.push(m), deviceId: "telephone" };
    const b = browser();
    await hub.handle(phone, { type: "push.state", requestId: "r1" });
    expect(replies.at(-1)).toMatchObject({ type: "pushState", subscribed: false });
    await hub.handle(phone, {
      type: "push.subscribe",
      requestId: "r2",
      endpoint: ENDPOINT,
      ...b,
      muted: [],
    });
    await hub.handle(phone, { type: "push.state", requestId: "r3", endpoint: ENDPOINT });
    expect(replies.at(-1)).toMatchObject({ type: "pushState", subscribed: true });
    // The computer does not see the phone's browser as its own.
    const computer = { send: (m: ServerMessage) => void replies.push(m) };
    await hub.handle(computer, { type: "push.state", requestId: "r4", endpoint: ENDPOINT });
    expect(replies.at(-1)).toMatchObject({ type: "pushState", subscribed: false });

    const threadId = hub.createThread({
      projectId: hub.createProject("demo", dir),
      agentId: "demo",
      permissionMode: "full",
      text: "/choix",
    });
    await expect.poll(() => svc.sent.length, { timeout: 10_000 }).toBe(1);
    expect(JSON.parse(b.decrypt(svc.sent[0]!.body))).toMatchObject({
      title: "Attend ta réponse",
      threadId,
    });
  });
});
