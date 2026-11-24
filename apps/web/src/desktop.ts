// The desktop app's window: its shell shows notifications itself, through the system.

export interface DesktopShell {
  notify(notice: { title: string; body: string; tag: string; threadId: string }): void;
  close(tag: string): void;
  onOpen(listener: (threadId: string) => void): void;
}

/** The shell, when this page runs in MoonAgentic's desktop app; undefined in a browser. */
export const desktopShell = (): DesktopShell | undefined =>
  (globalThis as { moonDesktop?: DesktopShell }).moonDesktop;
