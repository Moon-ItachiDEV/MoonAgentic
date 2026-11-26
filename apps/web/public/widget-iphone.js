// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: gray; icon-glyph: moon;

// MoonAgentic · widgets iPhone (Scriptable).
// Lance ce script une fois dans Scriptable pour le relier à ton MoonAgentic, puis ajoute un
// widget Scriptable et choisis ce script. Le champ « Parameter » du widget choisit quoi montrer :
//   écran d'accueil  claude | codex | antigravity | fils | abonnements | tout
//                    hermes | hermes journal | hermes taches | hermes discord
//   écran verrouillé claude | codex | antigravity | fils | hermes | tache
// Sans paramètre : petit = premier agent, moyen = abonnements, grand = tout.

const KEY = "moonagentic.widget";
const DEVICE_NAME = "Widgets iPhone";
/** iOS decides in the end; asked again no sooner than this. */
const REFRESH_MIN = 15;
/** Past this, the time of the reading is shown beside the title. */
const STALE_MIN = 30;

const C = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1f1f1f")),
  fg: Color.dynamic(new Color("#18181b"), new Color("#f3f3f3")),
  fg2: Color.dynamic(new Color("#3f3f46"), new Color("#d2d2d2")),
  muted: Color.dynamic(new Color("#62626b"), new Color("#9c9c9c")),
  accent: Color.dynamic(new Color("#3a55d6"), new Color("#8399ff")),
  amber: Color.dynamic(new Color("#d4901c"), new Color("#e2a740")),
  ok: Color.dynamic(new Color("#1f8a50"), new Color("#52c585")),
  err: Color.dynamic(new Color("#cc3d3d"), new Color("#f06c6c")),
  faint: Color.dynamic(new Color("#7a7a83"), new Color("#7c7c7c")),
  // A drawn image cannot follow the appearance: these read on white and on dark grey alike.
  ringTrack: new Color("#8e8e93", 0.26),
  ringAccent: new Color("#5a72ea"),
  ringAmber: new Color("#dc9a2a"),
  ringErr: new Color("#e05252"),
};

// ---------- settings and reading ----------

function settings() {
  if (!Keychain.contains(KEY)) return null;
  try {
    const saved = JSON.parse(Keychain.get(KEY));
    return saved && saved.url && saved.token ? saved : null;
  } catch {
    return null;
  }
}

/**
 * « https://discord.com/channels/1/2 » opens the Discord app on that channel, and
 * « …/channels/@me/2 » on that private conversation.
 */
function discordLink(text) {
  const found = /channels\/(@me|\d+)\/(\d+)/.exec(text || "");
  return found ? `discord://-/channels/${found[1]}/${found[2]}` : "";
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * The same three fields on a page of their own, for an iPhone whose alerts give back nothing
 * of what was typed. Null when the page is closed without « Relier ».
 */
async function askForm(saved) {
  const field = (id, label, value, more) =>
    `<label for="${id}">${label}</label>` +
    `<input id="${id}" value="${escapeHtml(value)}" autocapitalize="off" autocorrect="off" spellcheck="false" ${more}>`;
  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 17px -apple-system, sans-serif; margin: 24px 20px; }
  label { display: block; margin: 18px 0 6px; font-size: 13px; opacity: 0.6; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 12px 14px; border: 0;
    border-radius: 12px; background: rgba(127, 127, 127, 0.16); color: inherit; }
  button { width: 100%; margin-top: 28px; font: inherit; font-weight: 600; padding: 13px;
    border: 0; border-radius: 12px; background: #3a55d6; color: #fff; }
</style>
<form id="f">
${field("u", "Adresse de MoonAgentic", saved ? saved.url : "", 'type="url" placeholder="https://…ts.net"')}
${field("c", "Code d'appairage", "", 'inputmode="numeric"')}
${field("d", "Lien du salon Discord (facultatif)", saved ? saved.discordText || "" : "", 'type="url"')}
<button>Relier</button>
</form>`;
  const view = new WebView();
  await view.loadHTML(html);
  const sent = view.evaluateJavaScript(
    `document.getElementById("f").addEventListener("submit", (e) => {
       e.preventDefault();
       const read = (id) => document.getElementById(id).value;
       const values = [read("u"), read("c"), read("d")];
       document.body.textContent = "C'est noté. Ferme cette page pour terminer.";
       completion(values);
     });`,
    true,
  );
  const closed = view.present(false).then(() => null);
  const values = await Promise.race([sent, closed]);
  if (!Array.isArray(values)) return null;
  // What comes next shows alerts: they wait for the page to be closed.
  await closed;
  return values.map((value) => (typeof value === "string" ? value.trim() : ""));
}

async function setUp(saved) {
  const ask = new Alert();
  ask.title = "MoonAgentic";
  ask.message =
    "Adresse de MoonAgentic, puis un code d'appairage (Réglages › Accès distant, sur l'ordinateur).";
  const fields = [
    ask.addTextField("https://…ts.net", saved ? saved.url : ""),
    ask.addTextField("Code d'appairage", ""),
    ask.addTextField("Lien du salon Discord (facultatif)", saved ? saved.discordText || "" : ""),
  ];
  // No capital letter nor correction on an address.
  if (fields[0] && fields[0].setURLKeyboard) fields[0].setURLKeyboard();
  // On some iPhones `textFieldValue` gives back null: the field itself is then read, which
  // may still hold only what it started with.
  let lost = false;
  const typed = (place) => {
    let value = ask.textFieldValue(place);
    if (typeof value !== "string") {
      lost = true;
      value = fields[place] ? fields[place].text : "";
    }
    return typeof value === "string" ? value.trim() : "";
  };
  ask.addAction("Relier");
  ask.addCancelAction("Annuler");
  if ((await ask.presentAlert()) === -1) return null;
  let values = [typed(0), typed(1), typed(2)];
  // Nothing came back of what was typed: asked again on a page, which does give it back.
  if (lost && !values[1]) {
    values = await askForm(saved);
    if (!values) return null;
  }
  let url = values[0].replace(/\/+$/, "");
  const code = values[1];
  const discordText = values[2];
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!url) throw new Error("Il faut l'adresse de MoonAgentic et un code d'appairage.");
  const discord = discordLink(discordText);
  // Said before the code is used: a pairing code only serves once.
  if (discordText && !discord) {
    throw new Error(
      "Le lien Discord n'est pas reconnu. Dans Discord, appuie longtemps sur le salon puis « Copier le lien ».",
    );
  }
  let token = saved && saved.url === url ? saved.token : "";
  if (code) {
    const req = new Request(`${url}/api/pair`);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    req.body = JSON.stringify({ code, name: DEVICE_NAME });
    req.timeoutInterval = 15;
    // Read as text: a refusal or a proxy's page is not always JSON.
    const body = await req.loadString();
    const status = req.response ? req.response.statusCode : 200;
    let answer = null;
    try {
      answer = JSON.parse(body);
    } catch {
      // No JSON: the status says why.
    }
    if (!answer || !answer.token) {
      throw new Error(
        (answer && answer.message) || `L'appairage a été refusé (réponse ${status}).`,
      );
    }
    token = answer.token;
  }
  if (!url || !token) throw new Error("Il faut l'adresse et un code d'appairage.");
  const next = { url, token, discordText, discord };
  Keychain.set(KEY, JSON.stringify(next));
  return next;
}

function cacheFile(name) {
  const fm = FileManager.local();
  return fm.joinPath(fm.cacheDirectory(), `moonagentic-${name}`);
}

/** The latest reading, or the one before when the server cannot be reached. */
async function read(conf) {
  const fm = FileManager.local();
  const file = cacheFile("widget.json");
  try {
    const req = new Request(`${conf.url}/api/widget`);
    req.headers = { authorization: `Bearer ${conf.token}` };
    req.timeoutInterval = 12;
    const body = await req.loadString();
    const status = req.response ? req.response.statusCode : 200;
    if (status === 401) return { refused: true };
    const data = status === 200 ? JSON.parse(body) : null;
    if (!data || !Array.isArray(data.quotas)) throw new Error(`HTTP ${status}`);
    fm.writeString(file, JSON.stringify(data));
    return { data };
  } catch (error) {
    if (fm.fileExists(file)) {
      try {
        return { data: JSON.parse(fm.readString(file)), stale: true };
      } catch {
        // An unreadable copy is no copy.
      }
    }
    return { failed: String((error && error.message) || error) };
  }
}

/** Hermes's portrait, as the app shows it; kept once fetched. */
async function avatar(conf) {
  const fm = FileManager.local();
  const file = cacheFile("hermes.jpg");
  // A file that holds no image is asked for again.
  const cached = fm.fileExists(file) ? fm.readImage(file) : null;
  if (cached) return cached;
  try {
    const req = new Request(`${conf.url}/hermes-avatar.jpg`);
    req.timeoutInterval = 10;
    const image = await req.loadImage();
    const status = req.response ? req.response.statusCode : 200;
    if (status !== 200 || !image) return null;
    fm.writeImage(file, image);
    return image;
  } catch {
    return null;
  }
}

// ---------- words ----------

const two = (n) => String(n).padStart(2, "0");
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const clock = (at) => {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** « 20:40 » today or within a day, « sam. 14:20 » further away. */
function when(at, now) {
  if (sameDay(at, now) || Math.abs(at - now) < 20 * 3_600_000) return clock(at);
  return `${DAYS[new Date(at).getDay()]} ${clock(at)}`;
}
/** « sam. » for a far reset where room is short, the time otherwise. */
function whenShort(at, now) {
  if (sameDay(at, now) || Math.abs(at - now) < 20 * 3_600_000) return clock(at);
  return DAYS[new Date(at).getDay()];
}
function lasted(since, now) {
  const min = Math.max(0, Math.round((now - since) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} j`;
}
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/** « Claude Code » reads « Claude » where room is short. */
const shortName = (name) => name.replace(/\s+(Code|Agent|CLI)$/i, "");

const HERMES_WORDS = {
  asks: "Demande un accord",
  waiting: "T'attend",
  working: "Au travail",
  error: "Arrêté",
  acted: "Vient d'agir",
  done: "Terminé",
  off: "Déconnecté",
  rest: "Au repos",
};
const HERMES_DOT = {
  asks: C.amber,
  waiting: C.amber,
  working: C.accent,
  error: C.err,
  acted: C.accent,
  done: C.ok,
  off: C.faint,
};

/** The line under Hermes's state. */
function hermesSub(h, now) {
  if (h.state === "rest" || h.state === "off") return h.at ? `depuis ${when(h.at, now)}` : "";
  if (h.state === "waiting") return h.at ? `Message de ${clock(h.at)}` : h.title || "";
  if (h.state === "done" || h.state === "error" || h.state === "acted") {
    return [h.title, h.at ? clock(h.at) : ""].filter(Boolean).join(" · ");
  }
  return h.title || "";
}

// ---------- drawing ----------

function ringColor(used) {
  return used >= 100 ? C.ringErr : used >= 80 ? C.ringAmber : C.ringAccent;
}

/** A thin ring filled to `used` percent, starting at the top. */
function ringImage(used, size, width, color, track) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const r = (size - width) / 2;
  const c = size / 2;
  ctx.setLineWidth(width);
  ctx.setStrokeColor(track);
  ctx.strokeEllipse(new Rect(width / 2, width / 2, size - width, size - width));
  const share = Math.min(Math.max(used, 0), 100) / 100;
  if (share > 0) {
    const steps = Math.max(2, Math.ceil(share * 90));
    const point = (i) => {
      const a = -Math.PI / 2 + (i / steps) * share * 2 * Math.PI;
      return new Point(c + r * Math.cos(a), c + r * Math.sin(a));
    };
    const path = new Path();
    path.move(point(0));
    for (let i = 1; i <= steps; i++) path.addLine(point(i));
    ctx.addPath(path);
    ctx.setStrokeColor(color);
    ctx.strokePath();
    // Round ends, as in the app.
    ctx.setFillColor(color);
    for (const end of [point(0), point(steps)]) {
      ctx.fillEllipse(new Rect(end.x - width / 2, end.y - width / 2, width, width));
    }
  }
  return ctx.getImage();
}

function text(stack, value, font, color, lines = 1) {
  const t = stack.addText(String(value));
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  if (lines === 1) t.minimumScaleFactor = 0.85;
  return t;
}

/** A ring with its figure inside. */
function ring(stack, used, size) {
  const big = size > 40;
  const box = stack.addStack();
  box.size = new Size(size, size);
  box.backgroundImage = ringImage(used, size, big ? 4 : 3, ringColor(used), C.ringTrack);
  box.centerAlignContent();
  text(box, used, Font.semiboldSystemFont(big ? 17 : 12), C.fg);
  return box;
}

function dot(stack, color) {
  const d = stack.addStack();
  d.size = new Size(7, 7);
  d.cornerRadius = 3.5;
  d.backgroundColor = color;
  return d;
}

function title(widget, label, reading) {
  const row = widget.addStack();
  row.centerAlignContent();
  text(row, label, Font.mediumSystemFont(13), C.muted);
  if (reading.stale && Date.now() - reading.data.at > STALE_MIN * 60_000) {
    row.addSpacer();
    text(row, clock(reading.data.at), Font.systemFont(12), C.muted);
  }
  return row;
}

/** A column: something on top, two short lines under it, all centred. */
function column(parent, width) {
  const col = parent.addStack();
  col.layoutVertically();
  col.centerAlignContent();
  if (width) col.size = new Size(width, 0);
  return col;
}
function centred(col, build) {
  const row = col.addStack();
  row.addSpacer();
  build(row);
  row.addSpacer();
  return row;
}

// ---------- home screen ----------

function base(conf) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(16, 16, 16, 16);
  w.url = conf.url;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60_000);
  return w;
}

function findAgent(data, wanted) {
  const key = (wanted || "").toLowerCase();
  return (
    data.quotas.find((a) => key && (a.id === key || a.name.toLowerCase().includes(key))) ||
    data.quotas[0]
  );
}

/** Small: one agent, its session and its week. */
function smallAgent(conf, reading, wanted) {
  const { data } = reading;
  const w = base(conf);
  const agent = findAgent(data, wanted);
  title(w, agent ? shortName(agent.name) : cap(wanted || "Abonnements"), reading);
  w.addSpacer();
  if (!agent) {
    text(w, "Pas de chiffres", Font.mediumSystemFont(14), C.fg);
    return w;
  }
  const row = w.addStack();
  const shown = agent.windows.slice(0, 2);
  shown.forEach((win, i) => {
    if (i) row.addSpacer();
    const col = column(row);
    centred(col, (r) => ring(r, win.used, 56));
    col.addSpacer(8);
    centred(col, (r) => text(r, cap(win.short), Font.mediumSystemFont(12), C.fg2));
    col.addSpacer(2);
    centred(col, (r) =>
      text(r, win.resetsAt ? when(win.resetsAt, data.at) : " ", Font.systemFont(12), C.muted),
    );
  });
  if (shown.length === 1) row.addSpacer();
  return w;
}

/** Small: how many threads wait, how many work. */
function smallThreads(conf, reading) {
  const { data } = reading;
  const w = base(conf);
  title(w, "Fils", reading);
  w.addSpacer();
  for (const [count, label] of [
    [data.waiting, data.waiting > 1 ? "t'attendent" : "t'attend"],
    [data.running, "au travail"],
  ]) {
    const row = w.addStack();
    row.bottomAlignContent();
    row.spacing = 8;
    text(row, count, Font.semiboldSystemFont(30), C.fg);
    const side = row.addStack();
    side.setPadding(0, 0, 5, 0);
    text(side, label, Font.systemFont(13), C.muted);
    w.addSpacer(4);
  }
  w.addSpacer();
  const first = data.threads.find((t) => t.state === "waiting");
  text(w, first ? first.title : " ", Font.systemFont(12), C.muted);
  return w;
}

/** Medium: each agent's fullest window. */
function mediumQuotas(conf, reading) {
  const { data } = reading;
  const w = base(conf);
  title(w, "Abonnements", reading);
  w.addSpacer();
  const row = w.addStack();
  const agents = data.quotas.slice(0, 3);
  if (!agents.length) text(row, "Pas de chiffres", Font.mediumSystemFont(14), C.fg);
  agents.forEach((agent, i) => {
    if (i) row.addSpacer();
    const win = agent.windows[agent.tight];
    const col = column(row);
    centred(col, (r) => ring(r, win.used, 56));
    col.addSpacer(8);
    centred(col, (r) => text(r, shortName(agent.name), Font.mediumSystemFont(13), C.fg));
    col.addSpacer(2);
    const reset = win.resetsAt ? ` · ${whenShort(win.resetsAt, data.at)}` : "";
    centred(col, (r) => text(r, `${cap(win.short)}${reset}`, Font.systemFont(12), C.muted));
  });
  if (agents.length) {
    row.setPadding(0, 12, 0, 12);
  }
  return w;
}

/** A list row: a mark, two lines, something at the right. */
function listRow(parent, mark, head, sub, right, mono) {
  const row = parent.addStack();
  row.centerAlignContent();
  row.spacing = 12;
  const lead = row.addStack();
  lead.size = new Size(32, 32);
  lead.centerAlignContent();
  mark(lead);
  const words = row.addStack();
  words.layoutVertically();
  text(words, head, Font.mediumSystemFont(14), C.fg);
  if (sub) text(words, sub, Font.systemFont(12), C.muted);
  row.addSpacer();
  if (right) {
    text(row, right, mono ? Font.regularMonospacedSystemFont(12) : Font.systemFont(12), C.muted);
  }
  return row;
}

/** Large: the three quotas, then the threads that wait or work. */
function largeAll(conf, reading) {
  const { data } = reading;
  const w = base(conf);
  w.setPadding(18, 16, 18, 16);
  const stale = reading.stale && Date.now() - data.at > STALE_MIN * 60_000;
  if (stale) {
    title(w, "MoonAgentic", reading);
    w.addSpacer(10);
  }
  for (const agent of data.quotas.slice(0, 3)) {
    const win = agent.windows[agent.tight];
    listRow(
      w,
      (lead) => {
        lead.backgroundImage = ringImage(win.used, 32, 3, ringColor(win.used), C.ringTrack);
        text(lead, win.used, Font.semiboldSystemFont(12), C.fg);
      },
      shortName(agent.name),
      win.label,
      win.resetsAt ? when(win.resetsAt, data.at) : "",
      false,
    );
    w.addSpacer(12);
  }
  w.addSpacer(8);
  const room = stale ? 3 : 4;
  for (const thread of data.threads.slice(0, room)) {
    listRow(
      w,
      (lead) => dot(lead, thread.state === "waiting" ? C.amber : C.accent),
      thread.title,
      `${thread.project} · ${thread.by}`,
      thread.since ? lasted(thread.since, data.at) : "",
      true,
    );
    w.addSpacer(12);
  }
  w.addSpacer();
  return w;
}

/** Where a tap on Hermes goes: Discord when it waits for the user there, the app otherwise. */
function hermesUrl(conf, h) {
  return h.state === "waiting" && conf.discord ? conf.discord : conf.url;
}

function hermesState(stack, h, size) {
  const row = stack.addStack();
  row.centerAlignContent();
  row.spacing = 7;
  const color = HERMES_DOT[h.state];
  if (color) dot(row, color);
  text(row, HERMES_WORDS[h.state] || "Hermes", Font.mediumSystemFont(size), C.fg);
  return row;
}

function noHermes(conf, reading) {
  const w = base(conf);
  title(w, "Hermes", reading);
  w.addSpacer();
  text(w, "Pas installé", Font.mediumSystemFont(14), C.fg);
  return w;
}

/** Small: Hermes's face, its state, what it is about. */
function smallHermes(conf, reading, face) {
  const { data } = reading;
  const h = data.hermes;
  if (!h) return noHermes(conf, reading);
  const w = base(conf);
  w.url = hermesUrl(conf, h);
  title(w, "Hermes", reading);
  w.addSpacer();
  if (face) {
    const image = w.addImage(face);
    image.imageSize = new Size(64, 64);
    image.cornerRadius = 18;
    if (h.state === "rest" || h.state === "off") image.imageOpacity = 0.5;
    w.addSpacer(9);
  }
  hermesState(w, h, 14);
  w.addSpacer(3);
  text(w, hermesSub(h, data.at) || " ", Font.systemFont(12), C.muted);
  return w;
}

/** Medium: Hermes's face beside a list. */
function mediumHermes(conf, reading, face, kind) {
  const { data } = reading;
  const h = data.hermes;
  if (!h) return noHermes(conf, reading);
  const w = base(conf);
  w.url = kind === "discord" ? conf.discord || conf.url : hermesUrl(conf, h);
  const labels = { journal: "Journal", taches: "Tâches planifiées", discord: "Discord" };
  title(w, `Hermes · ${labels[kind]}`, reading);
  w.addSpacer(14);
  const row = w.addStack();
  row.topAlignContent();
  row.spacing = 14;
  if (face) {
    const image = row.addImage(face);
    image.imageSize = new Size(64, 64);
    image.cornerRadius = 18;
  }
  const list = row.addStack();
  list.layoutVertically();
  list.spacing = 7;
  const line = (left, right, head) => {
    const l = list.addStack();
    l.centerAlignContent();
    if (head) hermesState(l, h, 14);
    else text(l, left, Font.systemFont(13), C.fg);
    l.addSpacer();
    if (right) text(l, right, Font.regularMonospacedSystemFont(12), C.muted);
  };
  if (kind === "taches") {
    if (!h.next.length) text(list, "Aucune tâche planifiée", Font.systemFont(13), C.muted);
    for (const task of h.next) line(task.title, when(task.at, data.at));
  } else if (kind === "discord") {
    line("", h.at ? clock(h.at) : "", true);
    const about = [h.title, h.project].filter(Boolean).join(" · ");
    if (about) text(list, about, Font.systemFont(13), C.muted, 3);
  } else {
    const live = h.state === "working" || h.state === "asks" || h.state === "waiting";
    if (live) line("", h.at ? lasted(h.at, data.at) : "", true);
    const room = live ? 3 : 4;
    if (!h.log.length && !live) line("", "", true);
    for (const action of h.log.slice(0, room)) line(action.what, clock(action.at));
  }
  w.addSpacer();
  return w;
}

// ---------- lock screen ----------

function lockBase(conf) {
  const w = new ListWidget();
  // The system already keeps its own margin around these.
  w.setPadding(0, 0, 0, 0);
  if (conf) w.url = conf.url;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60_000);
  return w;
}

/** How many of the user's answers are awaited, Hermes's own or told on Discord. */
function lockSummary(data) {
  const parts = [];
  const tight = data.quotas
    .map((a) => ({ a, win: a.windows[a.tight] }))
    .sort((x, y) => y.win.used - x.win.used)[0];
  if (tight) parts.push(`${shortName(tight.a.name)} ${tight.win.used} %`);
  if (data.waiting) parts.push(`${data.waiting} ${data.waiting > 1 ? "t'attendent" : "t'attend"}`);
  else if (data.running) parts.push(`${data.running} au travail`);
  return parts.join(" · ") || "MoonAgentic";
}

function lockCircular(conf, data, wanted) {
  const w = lockBase(conf);
  w.addAccessoryWidgetBackground = true;
  const white = Color.white();
  const pair = (big, small, size = 20) => {
    w.addSpacer();
    centred(w, (r) => text(r, big, Font.semiboldSystemFont(size), white));
    centred(w, (r) => {
      text(r, small, Font.mediumSystemFont(10), white).textOpacity = 0.7;
    });
    w.addSpacer();
    return w;
  };
  const key = (wanted || "").toLowerCase();
  if (key === "fils") return pair(data.waiting, data.waiting > 1 ? "t'attendent" : "t'attend");
  if (key === "hermes") {
    const h = data.hermes;
    const waits = h && (h.state === "waiting" || h.state === "asks") ? 1 : 0;
    if (h && waits) w.url = hermesUrl(conf, h);
    return pair(waits, "Hermes");
  }
  if (key === "tache") {
    const task = data.hermes && data.hermes.next[0];
    return pair(task ? clock(task.at) : "–", "tâche", 15);
  }
  const agent = findAgent(data, key);
  if (!agent) return pair("–", "quota");
  const win = agent.windows[0];
  w.backgroundImage = ringImage(win.used, 72, 4, white, new Color("#ffffff", 0.25));
  return pair(win.used, shortName(agent.name));
}

function lockRectangular(conf, data, wanted) {
  const w = lockBase(conf);
  const white = Color.white();
  if ((wanted || "").toLowerCase() === "hermes" && data.hermes) {
    const h = data.hermes;
    w.url = hermesUrl(conf, h);
    text(w, "Hermes", Font.semiboldSystemFont(14), white);
    const word = HERMES_WORDS[h.state];
    if (word) text(w, word, Font.mediumSystemFont(13), white).textOpacity = 0.75;
    text(w, hermesSub(h, data.at) || " ", Font.mediumSystemFont(13), white).textOpacity = 0.75;
    return w;
  }
  w.spacing = 5;
  for (const agent of data.quotas.slice(0, 3)) {
    const win = agent.windows[agent.tight];
    const row = w.addStack();
    row.centerAlignContent();
    row.spacing = 8;
    const name = row.addStack();
    name.size = new Size(72, 0);
    text(name, shortName(agent.name), Font.mediumSystemFont(13), white);
    name.addSpacer();
    const bar = row.addStack();
    bar.size = new Size(44, 3);
    bar.cornerRadius = 1.5;
    bar.backgroundColor = new Color("#ffffff", 0.25);
    const fill = bar.addStack();
    fill.size = new Size(Math.max(1, (44 * Math.min(win.used, 100)) / 100), 3);
    fill.cornerRadius = 1.5;
    fill.backgroundColor = white;
    bar.addSpacer();
    row.addSpacer();
    text(row, win.used, Font.mediumSystemFont(13), white).textOpacity = 0.75;
  }
  if (!data.quotas.length) text(w, lockSummary(data), Font.mediumSystemFont(13), white);
  return w;
}

function lockInline(conf, data, wanted) {
  const w = lockBase(conf);
  const h = data.hermes;
  if ((wanted || "").toLowerCase() === "hermes" && h) {
    w.url = hermesUrl(conf, h);
    const at = h.at && h.state !== "rest" && h.state !== "off" ? ` · ${clock(h.at)}` : "";
    const word = HERMES_WORDS[h.state];
    w.addText(word ? `Hermes ${word.toLowerCase()}${at}` : "Hermes");
  } else w.addText(lockSummary(data));
  return w;
}

// ---------- which one ----------

/** On the lock screen: a few words alone, the system draws the rest. */
function lockNotice(conf, family, words) {
  const w = lockBase(conf);
  if (family === "accessoryInline") {
    w.addText(words);
    return w;
  }
  const white = Color.white();
  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const t = text(w, words, Font.mediumSystemFont(10), white, 2);
    t.minimumScaleFactor = 0.7;
    t.centerAlignText();
    return w;
  }
  text(w, words, Font.mediumSystemFont(13), white, 2);
  return w;
}

function notice(conf, family, short, words) {
  if (String(family).startsWith("accessory")) return lockNotice(conf, family, short);
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60_000);
  if (conf) w.url = conf.url;
  text(w, "MoonAgentic", Font.mediumSystemFont(13), C.muted);
  w.addSpacer(6);
  text(w, words, Font.systemFont(13), C.fg, 4);
  return w;
}

async function build(conf, family, wanted) {
  if (!conf) {
    return notice(null, family, "À relier", "Ouvre Scriptable et lance ce script pour le relier.");
  }
  const reading = await read(conf);
  if (reading.refused) {
    return notice(conf, family, "Accès retiré", "Accès retiré. Relance le script pour appairer.");
  }
  if (!reading.data) return notice(conf, family, "Injoignable", "MoonAgentic ne répond pas.");
  const { data } = reading;
  const key = (wanted || "").trim().toLowerCase();
  if (family === "accessoryCircular") return lockCircular(conf, data, key);
  if (family === "accessoryRectangular") return lockRectangular(conf, data, key);
  if (family === "accessoryInline") return lockInline(conf, data, key);
  if (key.startsWith("hermes")) {
    const face = await avatar(conf);
    const kind = /t[aâ]che/.test(key) ? "taches" : key.includes("discord") ? "discord" : "journal";
    return family === "small"
      ? smallHermes(conf, reading, face)
      : mediumHermes(conf, reading, face, kind);
  }
  if (family === "large" || key === "tout") return largeAll(conf, reading);
  if (key === "fils") return smallThreads(conf, reading);
  if (key === "abonnements" || (family === "medium" && !key)) return mediumQuotas(conf, reading);
  return smallAgent(conf, reading, key);
}

async function main() {
  let conf = settings();
  if (config.runsInWidget || config.runsInAccessoryWidget) {
    Script.setWidget(await build(conf, config.widgetFamily, args.widgetParameter));
    Script.complete();
    return;
  }
  // In the app: link once, then show what a widget would show.
  const menu = new Alert();
  menu.title = "MoonAgentic";
  const choices = [
    ["Petit · Claude", "small", "claude"],
    ["Petit · Fils", "small", "fils"],
    ["Petit · Hermes", "small", "hermes"],
    ["Moyen · Abonnements", "medium", "abonnements"],
    ["Moyen · Hermes journal", "medium", "hermes journal"],
    ["Moyen · Hermes tâches", "medium", "hermes taches"],
    ["Moyen · Hermes Discord", "medium", "hermes discord"],
    ["Grand · Tout", "large", "tout"],
  ];
  if (conf) for (const [label] of choices) menu.addAction(label);
  menu.addAction(conf ? "Relier de nouveau" : "Relier à MoonAgentic");
  menu.addCancelAction("Fermer");
  const picked = await menu.presentSheet();
  if (picked === -1) return Script.complete();
  if (!conf || picked === choices.length) {
    try {
      conf = await setUp(conf);
    } catch (error) {
      const failed = new Alert();
      failed.title = "Pas relié";
      failed.message = String((error && error.message) || error);
      failed.addAction("OK");
      await failed.presentAlert();
      return Script.complete();
    }
    if (!conf) return Script.complete();
    const done = new Alert();
    done.title = "Relié";
    done.message = "Ajoute maintenant un widget Scriptable et choisis ce script.";
    done.addAction("OK");
    await done.presentAlert();
    return Script.complete();
  }
  const [, family, wanted] = choices[picked];
  const widget = await build(conf, family, wanted);
  if (family === "small") await widget.presentSmall();
  else if (family === "medium") await widget.presentMedium();
  else await widget.presentLarge();
  Script.complete();
}

await main();
