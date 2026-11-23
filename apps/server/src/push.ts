// Web Push: the notifications a phone shows while MoonAgentic is closed. The server keeps a
// key pair of its own (VAPID) and, for each browser that asked, the address of its push
// service and the keys to encrypt for it. Each message is encrypted for that browser alone
// (RFC 8291) and signed with the server's key (RFC 8292): the push service reads neither.
// Written with node:crypto, without a dependency.
import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { type Notice, noticesFor, type Thread } from "@moonagentic/protocol";
import type { PushSubscriptionRow } from "./store.ts";

/** Where push subscriptions and the server's own keys are kept. */
export interface PushStorage {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  listPushSubscriptions(): PushSubscriptionRow[];
  savePushSubscription(row: PushSubscriptionRow): void;
  removePushSubscription(endpoint: string): boolean;
}

const VAPID_SETTING = "push.vapid";
/** Browsers that may be reached at once: more is a sign something is wrong. */
export const MAX_SUBSCRIPTIONS = 50;
/** How long a push service keeps a message for a phone that is off. */
const TTL_SECONDS = 24 * 60 * 60;
/** Who to reach about this server's messages, as push services ask: the project, no person. */
const SUBJECT = "https://github.com/Moon-ItachiDEV/MoonAgentic";
const SEND_TIMEOUT_MS = 15_000;
/** What one encrypted record holds, the 4096 bytes of a push less its header, tag and end. */
export const MAX_PAYLOAD = 4096 - 86 - 16 - 1;
/** A thread's title is cut there in a notice: a notification shows less anyway. */
const MAX_BODY = 200;

/**
 * The push services browsers use. Only those are written to: the address comes from a
 * device, and must not make the server send requests anywhere else, inside the network
 * included.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
];

/** True for an `https` address of a known push service, with no port or credentials. */
export function knownPushService(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((known) =>
    known.startsWith(".") ? host.endsWith(known) && host.length > known.length : host === known,
  );
}

const b64 = (bytes: Buffer) => bytes.toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");
const hmac = (key: Buffer, ...data: Buffer[]) => {
  const h = createHmac("sha256", key);
  for (const d of data) h.update(d);
  return h.digest();
};

/**
 * Encrypts one message for one browser, as RFC 8291 says, in a single record: a random salt,
 * a key pair made for this message alone, and the browser's own key and secret.
 */
export function encryptPayload(
  payload: Buffer,
  p256dh: string,
  auth: string,
  /** The salt and key pair a test gives, to compare with the RFC's own example. */
  fixed?: { salt: Buffer; asPrivate: Buffer },
): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error("Message push trop long.");
  const uaPublic = unb64(p256dh);
  const authSecret = unb64(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) {
    throw new Error("Clés de l'abonnement push invalides.");
  }
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  const asPublic = fixed ? ecdh.getPublicKey() : ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, keyInfo, Buffer.from([1]));
  const salt = fixed?.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])).subarray(
    0,
    16,
  );
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])).subarray(
    0,
    12,
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last record of the message ends with 2, and nothing pads it.
  const body = Buffer.concat([
    cipher.update(payload),
    cipher.update(Buffer.from([2])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body, cipher.getAuthTag()]);
}

/** The server's key pair for VAPID, made once and kept. */
export interface VapidKeys {
  /** The public key, uncompressed and base64url, as browsers take it. */
  publicKey: string;
  privateKey: KeyObject;
}

export function vapidKeys(storage: PushStorage): VapidKeys {
  let jwk = storage.getSetting<{ x: string; y: string; d: string } | null>(VAPID_SETTING, null);
  if (!jwk) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const exported = privateKey.export({ format: "jwk" });
    jwk = { x: exported.x!, y: exported.y!, d: exported.d! };
    storage.setSetting(VAPID_SETTING, jwk);
  }
  return {
    publicKey: b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)])),
    privateKey: createPrivateKey({ key: { kty: "EC", crv: "P-256", ...jwk }, format: "jwk" }),
  };
}

/** The `Authorization` header for one push service, signed with the server's key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: SUBJECT,
      }),
    ),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: keys.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

/** What the service worker receives: enough to show the notice and open its thread. */
export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  threadId: string;
}

export type PushSend = (url: string, init: RequestInit) => Promise<{ status: number }>;

/**
 * Sends the notices threads owe to the browsers that asked for Web Push, as the page does
 * while it is open. Each browser decides on arrival whether to show it: not while the app is
 * in front of the user there.
 */
export class Push {
  private readonly storage: PushStorage;
  private readonly send: PushSend;
  private readonly onError: (error: unknown) => void;
  private readonly quiet: (projectId: string) => boolean;
  private keys: VapidKeys | undefined;
  /** Each thread as last seen, to tell what changed. */
  private readonly seen = new Map<string, Thread>();

  constructor(
    storage: PushStorage,
    options: {
      send?: PushSend;
      onError?: (error: unknown) => void;
      /** A project nothing is said of for now: one locked with /lock. */
      quiet?: (projectId: string) => boolean;
    } = {},
  ) {
    this.storage = storage;
    this.send =
      options.send ??
      (async (url, init) => {
        // A push service that answers with a redirect would send the signed header elsewhere.
        const res = await fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        // Only its status is read: what it says beside is let go.
        await res.body?.cancel().catch(() => undefined);
        return res;
      });
    this.onError = options.onError ?? (() => undefined);
    this.quiet = options.quiet ?? (() => false);
  }

  publicKey(): string {
    this.keys ??= vapidKeys(this.storage);
    return this.keys.publicKey;
  }

  /** Keeps where one browser is reached, replacing what it said before. */
  subscribe(
    sub: { endpoint: string; p256dh: string; auth: string; muted: string[] },
    deviceId: string | undefined,
    now = Date.now(),
  ): void {
    if (!knownPushService(sub.endpoint)) {
      throw new Error("Ce service de notifications push n'est pas reconnu.");
    }
    // Checked now rather than at the first notice.
    encryptPayload(Buffer.from("{}"), sub.p256dh, sub.auth);
    const all = this.storage.listPushSubscriptions();
    const known = all.find((s) => s.endpoint === sub.endpoint);
    if (!known && all.length >= MAX_SUBSCRIPTIONS) {
      throw new Error(`Déjà ${MAX_SUBSCRIPTIONS} appareils reçoivent les notifications.`);
    }
    this.storage.savePushSubscription({
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      ...(deviceId ? { deviceId } : {}),
      muted: [...new Set(sub.muted)].slice(0, 500),
      createdAt: known?.createdAt ?? now,
    });
  }

  /**
   * Forgets the browsers of the devices `whose` names: the computer's own, when its token is
   * renewed, as one who had the old token may have subscribed a browser of theirs.
   */
  forget(whose: (deviceId: string | undefined) => boolean): void {
    for (const sub of this.storage.listPushSubscriptions()) {
      if (whose(sub.deviceId)) this.storage.removePushSubscription(sub.endpoint);
    }
  }

  /** Forgets a browser, when it was this device's. */
  unsubscribe(endpoint: string, deviceId: string | undefined): void {
    const known = this.storage.listPushSubscriptions().find((s) => s.endpoint === endpoint);
    if (known && known.deviceId === deviceId) this.storage.removePushSubscription(endpoint);
  }

  /** Whether this device's browser at that address is reached. */
  subscribed(endpoint: string, deviceId: string | undefined): boolean {
    return this.storage
      .listPushSubscriptions()
      .some((s) => s.endpoint === endpoint && s.deviceId === deviceId);
  }

  /** Called with each thread as it changes: sends what it now owes. */
  threadChanged(thread: Thread): void {
    const was = this.seen.get(thread.id);
    this.seen.set(thread.id, thread);
    if (!was || this.quiet(thread.projectId)) return;
    for (const notice of noticesFor([was], [thread])) void this.deliver(notice, thread.projectId);
  }

  threadRemoved(threadId: string): void {
    this.seen.delete(threadId);
  }

  /** Remembers the threads as they are, so only what changes from now on is sent. */
  know(threads: Thread[]): void {
    for (const thread of threads) this.seen.set(thread.id, thread);
  }

  /** Sends one notice to every browser that asked, but those quiet about its project. */
  async deliver(notice: Notice, projectId: string): Promise<void> {
    const subs = this.storage.listPushSubscriptions().filter((s) => !s.muted.includes(projectId));
    if (!subs.length) return;
    this.keys ??= vapidKeys(this.storage);
    const message: PushMessage = {
      title: notice.title,
      body: notice.body.length > MAX_BODY ? `${notice.body.slice(0, MAX_BODY - 1)}…` : notice.body,
      tag: notice.tag,
      threadId: notice.threadId,
    };
    const payload = Buffer.from(JSON.stringify(message));
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const res = await this.send(sub.endpoint, {
            method: "POST",
            headers: {
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: String(TTL_SECONDS),
              urgency: "high",
              // A newer notice about the same thing replaces one not delivered yet.
              topic: b64(hmac(Buffer.from("topic"), Buffer.from(notice.tag))).slice(0, 32),
              authorization: vapidAuthorization(sub.endpoint, this.keys!),
            },
            body: new Uint8Array(encryptPayload(payload, sub.p256dh, sub.auth)),
          });
          // The browser dropped it: no need to keep it.
          if (res.status === 404 || res.status === 410) {
            this.storage.removePushSubscription(sub.endpoint);
          } else if (res.status >= 400) {
            this.onError(new Error(`Service push : réponse ${res.status}.`));
          }
        } catch (error) {
          this.onError(error);
        }
      }),
    );
  }
}
