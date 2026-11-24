// What the interface may ask of the desktop shell, and nothing more: notifications shown by
// the system itself, as Electron shows none from a service worker and has no Web Push.
// Electron runs a sandboxed preload as a plain script: `require`, no `import`.
const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");

contextBridge.exposeInMainWorld("moonDesktop", {
  notify: (notice: { title: string; body: string; tag: string; threadId: string }) =>
    ipcRenderer.send("moonagentic.notice.show", notice),
  close: (tag: string) => ipcRenderer.send("moonagentic.notice.close", tag),
  onOpen: (listener: (threadId: string) => void) => {
    ipcRenderer.on("moonagentic.open", (_event, threadId: unknown) => {
      if (typeof threadId === "string") listener(threadId);
    });
  },
});
