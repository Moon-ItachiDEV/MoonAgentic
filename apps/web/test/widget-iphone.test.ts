// The iPhone widgets' script (public/widget-iphone.js), run against a stand-in for Scriptable:
// what each widget writes from one reading of the server, and how it gets its access.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Phone, runScript } from "./scriptable.ts";

const SCRIPT = path.join(import.meta.dirname, "../public/widget-iphone.js");
const URL = "https://mini.example.ts.net";
const KEY = "moonagentic.widget";

/** 26 November 2026, 18:42, on this computer's clock. */
const NOW = new Date(2026, 10, 26, 18, 42).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (h: number, m: number, day = 26) => new Date(2026, 10, day, h, m).getTime();

export const sample = (hermes: Record<string, unknown> = {}) => ({
  at: NOW,
  quotas: [
    {
      id: "claude",
      name: "Claude Code",
      tight: 0,
      windows: [
        { label: "Session de 5 h", short: "5 h", used: 86, resetsAt: at(20, 40) },
        { label: "Semaine, tous modèles", short: "semaine", used: 31, resetsAt: at(9, 0, 30) },
      ],
    },
    {
      id: "codex",
      name: "Codex",
      tight: 1,
      windows: [
        { label: "Session de 5 h", short: "5 h", used: 12, resetsAt: at(21, 15) },
        { label: "Semaine", short: "semaine", used: 44, resetsAt: at(14, 20, 28) },
      ],
    },
    {
      id: "antigravity",
      name: "Antigravity",
      tight: 0,
      windows: [
        { label: "Session de 5 h, Gemini", short: "5 h", used: 22, resetsAt: at(19, 55) },
        { label: "Semaine, Gemini", short: "semaine", used: 9, resetsAt: at(8, 0, 1) },
      ],
    },
  ],
  waiting: 1,
  running: 3,
  threads: [
    {
      title: "Autoriser git push",
      project: "MoonAgentic",
      by: "Opus 5.5",
      state: "waiting",
      since: NOW - 4 * MIN,
    },
    {
      title: "Concevoir les widgets iPhone",
      project: "MoonAgentic",
      by: "Fable 5.2",
      state: "running",
      since: NOW - 12 * MIN,
    },
    {
      title: "Revue de la PR 174",
      project: "MoonAgentic",
      by: "Gemini 4 Neon",
      state: "running",
      since: NOW - 31 * MIN,
    },
    {
      title: "Résumer les mails du jour",
      project: "Discussions",
      by: "Hermes",
      state: "running",
      since: NOW - 6 * MIN,
    },
    { title: "Un cinquième fil", project: "MoonAgentic", by: "Codex", state: "running" },
  ],
  hermes: {
    state: "working",
    title: "Résumer les mails du jour",
    project: "Discussions",
    at: NOW - 6 * MIN,
    log: [
      { what: "Message au coordinateur", project: "MoonAgentic", at: at(18, 40) },
      { what: "Tâche planifiée · Vérifie les quotas", project: "MoonAgentic", at: at(18, 12) },
      { what: "Message au fil · Revue de la PR 174", project: "MoonAgentic", at: at(17, 58) },
    ],
    next: [
      { title: "Vérifie les quotas avant la nuit", at: at(22, 0) },
      { title: "Relis les PR ouvertes", at: at(8, 30, 27) },
    ],
    ...hermes,
  },
});

const linked = (discord = "") =>
  new Map([[KEY, JSON.stringify({ url: URL, token: "jeton", discordText: "", discord })]]);
export const phone = (data: unknown = sample(), more: Partial<Phone> = {}): Phone => ({
  keychain: linked(),
  answer: (url, request) => {
    if (url === `${URL}/api/widget`) {
      return request.headers.authorization === "Bearer jeton"
        ? { status: 200, body: JSON.stringify(data) }
        : { status: 401 };
    }
    if (url === `${URL}/hermes-avatar.jpg`) return { status: 200 };
    return { status: 404 };
  },
  ...more,
});
const show = async (family: string, parameter?: string, data: unknown = sample(), more = {}) => {
  const run = await runScript(SCRIPT, phone(data, more), {
    family,
    ...(parameter ? { parameter } : {}),
  });
  return run.widget!;
};

describe("home screen", () => {
  it("small, one agent: its session and its week, with when each frees up", async () => {
    const texts = (await show("small", "claude")).texts();
    expect(texts).toEqual(["Claude", "86", "5 h", "20:40", "31", "Semaine", "lun. 09:00"]);
    expect((await show("small", "codex")).texts().slice(0, 2)).toEqual(["Codex", "12"]);
    // Without a parameter: the first agent.
    expect((await show("small")).texts()[0]).toBe("Claude");
  });

  it("small, threads: how many wait and work, and the first that waits", async () => {
    expect((await show("small", "fils")).texts()).toEqual([
      "Fils",
      "1",
      "t'attend",
      "3",
      "au travail",
      "Autoriser git push",
    ]);
  });

  it("medium: each agent's fullest window", async () => {
    expect((await show("medium")).texts()).toEqual([
      "Abonnements",
      "86",
      "Claude",
      "5 h · 20:40",
      "44",
      "Codex",
      "Semaine · sam.",
      "22",
      "Antigravity",
      "5 h · 19:55",
    ]);
  });

  it("large: the quotas, then four threads, those that wait first", async () => {
    const texts = (await show("large")).texts();
    expect(texts.slice(0, 4)).toEqual(["86", "Claude", "Session de 5 h", "20:40"]);
    expect(texts).toContain("sam. 14:20");
    expect(texts.slice(12)).toEqual([
      "Autoriser git push",
      "MoonAgentic · Opus 5.5",
      "4 min",
      "Concevoir les widgets iPhone",
      "MoonAgentic · Fable 5.2",
      "12 min",
      "Revue de la PR 174",
      "MoonAgentic · Gemini 4 Neon",
      "31 min",
      "Résumer les mails du jour",
      "Discussions · Hermes",
      "6 min",
    ]);
  });

  it("opens MoonAgentic when touched, and asks again in a quarter of an hour", async () => {
    const widget = await show("medium");
    expect(widget.url).toBe(URL);
    expect(widget.refreshAfterDate!.getTime() - Date.now()).toBeGreaterThan(14 * MIN);
  });
});

describe("Hermes", () => {
  const states: [Record<string, unknown>, string[]][] = [
    [{}, ["Hermes", "Au travail", "Résumer les mails du jour"]],
    [{ state: "rest", title: undefined, at: at(14, 5) }, ["Hermes", "Au repos", "depuis 14:05"]],
    [{ state: "off", title: undefined, at: at(17, 2) }, ["Hermes", "Déconnecté", "depuis 17:02"]],
    [{ state: "waiting", at: at(18, 31) }, ["Hermes", "T'attend", "Message de 18:31"]],
    [
      { state: "asks", title: "Autoriser git push" },
      ["Hermes", "Demande un accord", "Autoriser git push"],
    ],
    [{ state: "done", at: at(18, 36) }, ["Hermes", "Terminé", "Résumer les mails du jour · 18:36"]],
    [{ state: "error", at: at(18, 20) }, ["Hermes", "Arrêté", "Résumer les mails du jour · 18:20"]],
    [
      { state: "acted", title: "Message au coordinateur", at: at(18, 40) },
      ["Hermes", "Vient d'agir", "Message au coordinateur · 18:40"],
    ],
  ];
  it.each(states)("small, %j", async (hermes, texts) => {
    expect((await show("small", "hermes", sample(hermes))).texts()).toEqual(texts);
  });

  it("opens Discord when it waits for the user there, MoonAgentic otherwise", async () => {
    const discord = "discord://-/channels/1/2";
    const more = { keychain: linked(discord) };
    const waiting = sample({ state: "waiting" });
    expect((await show("small", "hermes", waiting, more)).url).toBe(discord);
    expect((await show("accessoryRectangular", "hermes", waiting, more)).url).toBe(discord);
    expect((await show("small", "hermes", sample(), more)).url).toBe(URL);
    // No Discord channel given: the app, as for the rest.
    expect((await show("small", "hermes", waiting)).url).toBe(URL);
  });

  it("medium: its journal, its planned tasks, or what waits on Discord", async () => {
    expect((await show("medium", "hermes journal")).texts()).toEqual([
      "Hermes · Journal",
      "Au travail",
      "6 min",
      "Message au coordinateur",
      "18:40",
      "Tâche planifiée · Vérifie les quotas",
      "18:12",
      "Message au fil · Revue de la PR 174",
      "17:58",
    ]);
    expect((await show("medium", "hermes taches")).texts()).toEqual([
      "Hermes · Tâches planifiées",
      "Vérifie les quotas avant la nuit",
      "22:00",
      "Relis les PR ouvertes",
      "08:30",
    ]);
    const waiting = sample({
      state: "waiting",
      title: "Autoriser git push",
      project: "MoonAgentic",
      at: at(18, 31),
    });
    expect((await show("medium", "hermes discord", waiting)).texts()).toEqual([
      "Hermes · Discord",
      "T'attend",
      "18:31",
      "Autoriser git push · MoonAgentic",
    ]);
  });

  it("says so when Hermes is not installed", async () => {
    const data = { ...sample(), hermes: undefined };
    expect((await show("small", "hermes", data)).texts()).toEqual(["Hermes", "Pas installé"]);
  });
});

describe("lock screen", () => {
  it("inline: the fullest quota and what waits", async () => {
    expect((await show("accessoryInline")).texts()).toEqual(["Claude 86 % · 1 t'attend"]);
    const calm = { ...sample(), waiting: 0 };
    expect((await show("accessoryInline", undefined, calm)).texts()).toEqual([
      "Claude 86 % · 3 au travail",
    ]);
    expect(
      (
        await show("accessoryInline", "hermes", sample({ state: "waiting", at: at(18, 31) }))
      ).texts(),
    ).toEqual(["Hermes t'attend · 18:31"]);
  });

  it("rectangular: a bar for each agent, or Hermes", async () => {
    expect((await show("accessoryRectangular")).texts()).toEqual([
      "Claude",
      "86",
      "Codex",
      "44",
      "Antigravity",
      "22",
    ]);
    expect((await show("accessoryRectangular", "hermes")).texts()).toEqual([
      "Hermes",
      "Au travail",
      "Résumer les mails du jour",
    ]);
  });

  it("circular: an agent's session, the threads that wait, Hermes, its next task", async () => {
    expect((await show("accessoryCircular")).texts()).toEqual(["86", "Claude"]);
    expect((await show("accessoryCircular", "codex")).texts()).toEqual(["12", "Codex"]);
    expect((await show("accessoryCircular", "fils")).texts()).toEqual(["1", "t'attend"]);
    expect((await show("accessoryCircular", "hermes")).texts()).toEqual(["0", "Hermes"]);
    expect((await show("accessoryCircular", "tache")).texts()).toEqual(["22:00", "tâche"]);
  });
});

describe("the access", () => {
  it("pairs with a code typed once, and keeps the token in the keychain", async () => {
    const run = await runScript(SCRIPT, {
      alerts: [
        { pick: 0 },
        { pick: 0, fields: [`${URL}/`, "123-456", "https://discord.com/channels/11/22"] },
      ],
      answer: (url, request) => {
        expect(url).toBe(`${URL}/api/pair`);
        expect(request.method).toBe("POST");
        expect(request.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(request.body!)).toEqual({ code: "123-456", name: "Widgets iPhone" });
        return { status: 200, body: JSON.stringify({ id: "d1", token: "jeton-neuf" }) };
      },
    });
    expect(JSON.parse(run.keychain.get(KEY)!)).toEqual({
      url: URL,
      token: "jeton-neuf",
      discordText: "https://discord.com/channels/11/22",
      discord: "discord://-/channels/11/22",
    });
    expect(run.alerts.at(-1)!.title).toBe("Relié");
  });

  it("says why when the code is refused, and keeps nothing", async () => {
    const run = await runScript(SCRIPT, {
      alerts: [{ pick: 0 }, { pick: 0, fields: [URL, "000-000", ""] }],
      answer: () => ({ status: 401, body: JSON.stringify({ message: "Ce code ne marche pas." }) }),
    });
    expect(run.keychain.has(KEY)).toBe(false);
    expect(run.alerts.at(-1)).toMatchObject({
      title: "Pas relié",
      message: "Ce code ne marche pas.",
    });
  });

  it("asks to be linked before anything, without calling any server", async () => {
    const run = await runScript(SCRIPT, { answer: () => ({ status: 500 }) }, { family: "small" });
    expect(run.widget!.texts().join(" ")).toContain("lance ce script");
    expect(run.asked).toEqual([]);
  });

  it("says its access was taken away, rather than show an old reading", async () => {
    const files = new Map<string, string>();
    await runScript(SCRIPT, phone(sample(), { files }), { family: "small" });
    const cut = phone(sample(), { files, answer: () => ({ status: 401 }) });
    const run = await runScript(SCRIPT, cut, { family: "small" });
    expect(run.widget!.texts().join(" ")).toContain("Accès retiré");
  });

  it("shows the last reading when the server is out of reach, with its time once old", async () => {
    const files = new Map<string, string>();
    const old = { ...sample(), at: Date.now() - 2 * HOUR };
    await runScript(SCRIPT, phone(old, { files }), { family: "small", parameter: "fils" });
    const away = phone(old, { files, answer: () => ({ status: 0 }) });
    const run = await runScript(SCRIPT, away, { family: "small", parameter: "fils" });
    const texts = run.widget!.texts();
    expect(texts[0]).toBe("Fils");
    expect(texts[1]).toMatch(/^\d\d:\d\d$/);
    expect(texts).toContain("Autoriser git push");
    // Never read at all: it says so.
    const never = await runScript(SCRIPT, phone(old, { answer: () => ({ status: 0 }) }), {
      family: "small",
    });
    expect(never.widget!.texts().join(" ")).toContain("ne répond pas");
  });

  it("previews a widget from the app once linked", async () => {
    const run = await runScript(SCRIPT, phone(sample(), { alerts: [{ pick: 3 }] }));
    expect(run.widget!.presented).toBe("medium");
    expect(run.widget!.texts()[0]).toBe("Abonnements");
  });
});

// Neon's review of PR 177.
describe("review of PR 177", () => {
  const images = (widget: { html: (theme: "light") => string }) =>
    (widget.html("light").match(/<img /g) ?? []).length;

  it("asks for Hermes's portrait again after a failed first try", async () => {
    const files = new Map<string, string | null>();
    let portrait = 404;
    const answer: Phone["answer"] = (url) =>
      url.endsWith("/hermes-avatar.jpg")
        ? { status: portrait }
        : { status: 200, body: JSON.stringify(sample()) };
    const first = await runScript(SCRIPT, phone(sample(), { files, answer }), {
      family: "small",
      parameter: "hermes",
    });
    expect(images(first.widget!)).toBe(0);
    portrait = 200;
    const second = await runScript(SCRIPT, phone(sample(), { files, answer }), {
      family: "small",
      parameter: "hermes",
    });
    expect(second.asked).toContain(`GET ${URL}/hermes-avatar.jpg`);
    expect(images(second.widget!)).toBe(1);
  });

  it.each(["accessoryInline", "accessoryCircular", "accessoryRectangular"])(
    "%s says what is wrong in its own few words, with no background",
    async (family) => {
      const cut = phone(sample(), { answer: () => ({ status: 401 }) });
      const refused = (await runScript(SCRIPT, cut, { family })).widget!;
      expect(refused.texts()).toEqual(["Accès retiré"]);
      expect(refused.backgroundColor).toBeUndefined();
      expect(refused.refreshAfterDate).toBeInstanceOf(Date);
      const away = phone(sample(), { answer: () => ({ status: 0 }) });
      expect((await runScript(SCRIPT, away, { family })).widget!.texts()).toEqual(["Injoignable"]);
      const unlinked = await runScript(SCRIPT, { answer: () => ({ status: 500 }) }, { family });
      expect(unlinked.widget!.texts()).toEqual(["À relier"]);
    },
  );

  it("leaves a lock screen widget all its room", async () => {
    for (const family of ["accessoryCircular", "accessoryRectangular", "accessoryInline"]) {
      expect((await show(family)).padding).toEqual([0, 0, 0, 0]);
    }
  });

  it("opens a private Discord conversation too, and refuses a link it cannot read", async () => {
    const link = async (typed: string) => {
      const run = await runScript(SCRIPT, {
        alerts: [{ pick: 0 }, { pick: 0, fields: [URL, "123-456", typed] }],
        answer: () => ({ status: 200, body: JSON.stringify({ token: "jeton" }) }),
      });
      return { run, saved: run.keychain.get(KEY) };
    };
    const dm = await link("https://discord.com/channels/@me/42");
    expect(JSON.parse(dm.saved!).discord).toBe("discord://-/channels/@me/42");
    const wrong = await link("discord salon moonagentic");
    expect(wrong.saved).toBeUndefined();
    expect(wrong.run.alerts.at(-1)).toMatchObject({ title: "Pas relié" });
    expect(wrong.run.alerts.at(-1)!.message).toContain("Discord");
  });

  it("says why in words when the server answers the pairing with no JSON", async () => {
    for (const status of [403, 502]) {
      const run = await runScript(SCRIPT, {
        alerts: [{ pick: 0 }, { pick: 0, fields: [URL, "123-456", ""] }],
        answer: () => ({ status, body: status === 502 ? "<html>Bad Gateway</html>" : "" }),
      });
      const said = run.alerts.at(-1)!;
      expect(said.title).toBe("Pas relié");
      expect(said.message).toContain(String(status));
      expect(said.message).not.toMatch(/JSON|Unexpected/);
    }
  });

  it("counts several threads that wait in the plural on the lock screen", async () => {
    const data = { ...sample(), waiting: 2 };
    expect((await show("accessoryCircular", "fils", data)).texts()).toEqual(["2", "t'attendent"]);
  });

  it("shows a state of Hermes it does not know yet rather than nothing", async () => {
    const data = sample({ state: "nouveau", title: "Un état futur" });
    expect((await show("accessoryInline", "hermes", data)).texts()).toEqual(["Hermes"]);
    expect((await show("accessoryRectangular", "hermes", data)).texts()[0]).toBe("Hermes");
    expect((await show("small", "hermes", data)).texts()).toContain("Un état futur");
    expect((await show("medium", "hermes journal", data)).texts()[0]).toBe("Hermes · Journal");
  });
});

// The first try on a real iPhone, 26 November 2026.
describe("first try on a real iPhone", () => {
  const paired = () => ({ status: 200, body: JSON.stringify({ token: "jeton" }) });

  it("asks on a page when the alert gives back nothing of what was typed", async () => {
    const run = await runScript(SCRIPT, {
      fieldValuesLost: true,
      alerts: [{ pick: 0 }, { pick: 0, fields: [URL, "123-456", ""] }],
      form: [` ${URL}/ `, " 123-456 ", ""],
      answer: paired,
    });
    expect(run.pages).toHaveLength(1);
    expect(run.pages[0]).toContain("Code d'appairage");
    expect(run.asked).toEqual([`POST ${URL}/api/pair`]);
    expect(run.alerts.at(-1)).toMatchObject({ title: "Relié" });
    expect(JSON.parse(run.keychain.get(KEY)!)).toMatchObject({ url: URL, token: "jeton" });
  });

  it("links nothing when that page is closed without being sent", async () => {
    const run = await runScript(SCRIPT, {
      fieldValuesLost: true,
      alerts: [{ pick: 0 }, { pick: 0, fields: [URL, "123-456", ""] }],
      answer: paired,
    });
    expect(run.pages).toHaveLength(1);
    expect(run.asked).toEqual([]);
    expect(run.keychain.has(KEY)).toBe(false);
  });

  it("shows no page on an iPhone whose alert works, and says what is missing", async () => {
    const run = await runScript(SCRIPT, {
      alerts: [{ pick: 0 }, { pick: 0 }],
      answer: () => ({ status: 500 }),
    });
    expect(run.pages).toEqual([]);
    expect(run.alerts.at(-1)).toMatchObject({ title: "Pas relié" });
    expect(run.alerts.at(-1)!.message).toMatch(/adresse/);
    expect(run.asked).toEqual([]);
  });

  it("puts back the address already known into that page, safely", async () => {
    const keychain = new Map([
      [KEY, JSON.stringify({ url: 'https://a"><b>.ts.net', token: "t", discordText: "" })],
    ]);
    const run = await runScript(SCRIPT, {
      fieldValuesLost: true,
      keychain,
      alerts: [{ pick: 8 }, { pick: 0 }],
      answer: paired,
    });
    expect(run.pages[0]).toContain('value="https://a&quot;&gt;&lt;b&gt;.ts.net"');
  });

  it("adds https:// to an address typed without it, on a keyboard made for addresses", async () => {
    const run = await runScript(SCRIPT, {
      alerts: [{ pick: 0 }, { pick: 0, fields: ["mini.example.ts.net/", "123-456", ""] }],
      answer: paired,
    });
    expect(run.keyboards.map((k) => k.keyboard)).toEqual(["url", "default", "default"]);
    expect(run.asked).toEqual([`POST ${URL}/api/pair`]);
    expect(JSON.parse(run.keychain.get(KEY)!).url).toBe(URL);
  });
});
