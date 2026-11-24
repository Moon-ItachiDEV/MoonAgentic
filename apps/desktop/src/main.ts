// MoonAgentic's desktop shell: it runs the same server as `pnpm start` and shows the same
// interface in a window, with an icon by the clock so that it keeps running once closed.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import { DesktopCrashLog, formatDesktopError } from "./crash-log.ts";
import { readNotice } from "./notices.ts";
import { ServerProcess, type ServerState } from "./server-process.ts";
import { readSettings, writeSettings } from "./settings.ts";
import { adoptLoginShellPath } from "./shell-path.ts";
import { stateLabel, statusPage } from "./status-page.ts";

const APP_ID = "com.moonagentic.desktop";
const PORT = Number(process.env.MOONAGENTIC_PORT ?? "4747");
const HIDDEN_ARG = "--hidden";
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");

// From the installer, the server sits in the app's resources; from the repository, in apps/.
const serverDir = app.isPackaged
  ? path.join(process.resourcesPath, "moonagentic", "server")
  : path.join(here, "..", "..", "server");
const dataDir = path.resolve(
  process.env.MOONAGENTIC_HOME ?? path.join(os.homedir(), ".moonagentic"),
);
const logDir = path.join(dataDir, "logs");
const crashLog = new DesktopCrashLog(logDir);
// Observe uncaught exceptions and unhandled rejections without swallowing Electron's own handling.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  crashLog.write(`[main] ${origin} : ${formatDesktopError(error)}`);
});
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const settings = readSettings(settingsFile);

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let sleepBlocker: number | undefined;
/** The interface is shown, or on its way: the status page no longer replaces it. */
let appLoaded = false;

if (!app.requestSingleInstanceLock()) {
  // MoonAgentic is already running: the one already open shows itself instead.
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(start);
}

const server = new ServerProcess({
  // Electron runs the server as Node would, and so does every process the server starts with
  // its own program (agent adapters), which inherit this variable.
  command: process.execPath,
  script: path.join(serverDir, "src", "bin.ts"),
  args: ["--port", String(PORT), "--data-dir", dataDir],
  // Read at each start: on macOS, after the terminal's PATH is adopted.
  env: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" }),
  onState: (state) => stateChanged(state),
});

function start(): void {
  process.env.MOONAGENTIC_APP_VERSION = app.getVersion();
  app.setAppUserModelId(APP_ID);
  adoptLoginShellPath();
  applySleepSetting();
  createTray();
  const openedAtLogin =
    process.argv.includes(HIDDEN_ARG) || app.getLoginItemSettings().wasOpenedAtLogin;
  createWindow(!openedAtLogin);
  server.start();
}

/** The address with the token kept in the data folder now: it changes when renewed. */
function appUrl(): string | undefined {
  try {
    const token = readFileSync(path.join(dataDir, "token"), "utf8").trim();
    return `http://127.0.0.1:${PORT}/#token=${encodeURIComponent(token)}`;
  } catch {
    return server.state.kind === "ready" ? server.state.url : undefined;
  }
}

const serverOrigin = `http://127.0.0.1:${PORT}`;
const isServerPage = (url: string) => {
  try {
    return new URL(url).origin === serverOrigin;
  } catch {
    return false;
  }
};

function createWindow(show: boolean): void {
  window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 360,
    minHeight: 480,
    show,
    title: "MoonAgentic",
    backgroundColor: "#111113",
    autoHideMenuBar: true,
    icon: path.join(assets, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, "preload.js"),
      // Hidden by the tray icon, the page still follows its agents and notifies.
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  // Links out of MoonAgentic (GitHub, a pull request) open in the usual browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isServerPage(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isServerPage(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  contents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isServerPage(wc.getURL()) && ALLOWED.has(permission));
  });
  // The server can go down between saying it is ready and the page loading: the status page
  // comes back, and the interface is loaded again once the server is ready.
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is a load replaced by another one, not a failure.
    if (!isMainFrame || code === -3 || !isServerPage(url)) return;
    crashLog.write(`[renderer] échec chargement (${code}) : ${description || "erreur inconnue"}`);
    appLoaded = false;
    if (server.state.kind === "ready") setTimeout(() => showStatus(server.state), 1_000);
    else showStatus(server.state);
  });
  window.on("close", (event) => {
    if (quitting) return;
    // Closing only hides it: the agents keep working, the tray icon brings it back.
    event.preventDefault();
    window?.hide();
    backgroundHint();
  });
  showStatus(server.state);
}

/** What the interface asks for: notifications, the microphone for dictation, the clipboard. */
const ALLOWED = new Set(["notifications", "media", "clipboard-sanitized-write", "clipboard-read"]);

/** Shown notices, kept by tag: one replaces the last, and a click still reaches its handler. */
const notices = new Map<string, Notification>();

/** Only the interface asks: its window's main frame, not a status page nor another site. */
const fromInterface = (event: IpcMainEvent) =>
  !!window &&
  event.senderFrame === window.webContents.mainFrame &&
  isServerPage(event.senderFrame.url);

ipcMain.on("moonagentic.notice.show", (event, value: unknown) => {
  const notice = readNotice(value);
  if (!notice || !fromInterface(event) || !Notification.isSupported()) return;
  notices.get(notice.tag)?.close();
  const shown = new Notification({
    title: notice.title,
    body: notice.body,
    icon: path.join(assets, "icon.png"),
  });
  notices.set(notice.tag, shown);
  const forget = () => {
    if (notices.get(notice.tag) === shown) notices.delete(notice.tag);
  };
  shown.on("click", () => {
    forget();
    showWindow();
    if (notice.threadId) window?.webContents.send("moonagentic.open", notice.threadId);
  });
  shown.on("close", forget);
  shown.show();
});

ipcMain.on("moonagentic.notice.close", (event, tag: unknown) => {
  if (typeof tag !== "string" || !fromInterface(event)) return;
  notices.get(tag)?.close();
  notices.delete(tag);
});

function showStatus(state: ServerState): void {
  if (!window || appLoaded) return;
  if (state.kind === "ready") {
    appLoaded = true;
    void window.loadURL(appUrl() ?? state.url);
    return;
  }
  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(statusPage(state, logDir))}`,
  );
}

function showWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function backgroundHint(): void {
  if (settings.backgroundHintShown || !Notification.isSupported()) return;
  settings.backgroundHintShown = true;
  writeSettings(settingsFile, settings);
  new Notification({
    title: "MoonAgentic tourne toujours",
    body: "Tes agents continuent. L'icône près de l'horloge rouvre la fenêtre ou quitte MoonAgentic.",
  }).show();
}

function stateChanged(state: ServerState): void {
  showStatus(state);
  updateTray();
}

function applySleepSetting(): void {
  if (settings.preventSleep && sleepBlocker === undefined) {
    sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!settings.preventSleep && sleepBlocker !== undefined) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = undefined;
  }
}

function trayImage() {
  if (process.platform === "darwin") {
    // A template image: macOS draws it in the menu bar's own color.
    const image = nativeImage.createFromPath(path.join(assets, "trayTemplate.png"));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(path.join(assets, "tray.png"));
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.on("click", () => showWindow());
  updateTray();
}

const loginItemOptions = () => (process.platform === "win32" ? { args: [HIDDEN_ARG] } : {});

/** Starting with the session, where Electron can set it up: Windows and macOS. */
function loginItemMenu(): MenuItemConstructorOptions[] {
  if (process.platform !== "win32" && process.platform !== "darwin") return [];
  return [
    {
      label: process.platform === "darwin" ? "Ouvrir à la connexion" : "Lancer avec Windows",
      type: "checkbox",
      checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, ...loginItemOptions() });
        updateTray();
      },
    },
  ];
}

function updateTray(): void {
  if (!tray) return;
  const label = stateLabel(server.state, PORT);
  tray.setToolTip(`MoonAgentic · ${label}`);
  const ready = server.state.kind === "ready";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ouvrir MoonAgentic", click: () => showWindow() },
      { label, enabled: false },
      { type: "separator" },
      {
        label: "Ouvrir dans le navigateur",
        enabled: ready,
        click: () => {
          const url = appUrl();
          if (url) void shell.openExternal(url);
        },
      },
      ...loginItemMenu(),
      {
        label: "Empêcher la mise en veille",
        type: "checkbox",
        checked: settings.preventSleep,
        click: (item) => {
          settings.preventSleep = item.checked;
          writeSettings(settingsFile, settings);
          applySleepSetting();
        },
      },
      { type: "separator" },
      { label: "Redémarrer le serveur", click: () => void server.restart() },
      { label: "Ouvrir le dossier des journaux", click: () => void shell.openPath(logDir) },
      { type: "separator" },
      { label: "Quitter MoonAgentic", click: () => app.quit() },
    ]),
  );
}

app.on("render-process-gone", (_event, _webContents, details) => {
  crashLog.write(
    `[renderer] processus arrêté : reason=${details.reason} exitCode=${details.exitCode}`,
  );
});
app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  crashLog.write(
    `[child] processus arrêté : type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
  );
});
app.on("activate", () => showWindow());
// The window only hides, so this comes only from quitting: nothing to do but quit.
app.on("window-all-closed", () => undefined);
app.on("before-quit", (event) => {
  const stopping = quitting;
  quitting = true;
  if (server.state.kind === "stopped") return;
  // Agents are stopped before the app ends, so none is left running unseen.
  event.preventDefault();
  if (!stopping) void server.stop().then(() => app.quit());
});
