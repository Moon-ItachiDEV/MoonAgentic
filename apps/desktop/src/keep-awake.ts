// Keeping Windows awake for real. Electron's « prevent-app-suspension » asks Windows only not to
// suspend the app (PowerRequestExecutionRequired since Windows 8): on a computer that has only
// modern standby (S0), the screen turning off still puts it to sleep, network and all. Only a
// display request keeps such a computer out of standby, so that is what Windows gets.

/** The Electron blocker that really keeps this platform from sleeping. */
export function sleepBlockerKind(
  platform: NodeJS.Platform,
): "prevent-display-sleep" | "prevent-app-suspension" {
  return platform === "win32" ? "prevent-display-sleep" : "prevent-app-suspension";
}

/** How long Windows is kept awake while an update replaces the app and starts it again. */
export const UPDATE_AWAKE_SECONDS = 15 * 60;

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, written in decimal for PowerShell. */
export const AWAKE_FLAGS = 0x80000000 + 0x1 + 0x2;

/**
 * The PowerShell that keeps Windows awake for `seconds`, then lets it sleep again: the app is
 * closed while its installer runs, so it cannot hold the computer itself.
 */
export function keepAwakeScript(seconds: number): string {
  const s = Math.max(1, Math.min(24 * 3600, Math.round(seconds)));
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace MoonAgentic -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
    `[void][MoonAgentic.Power]::SetThreadExecutionState([uint32]${AWAKE_FLAGS})`,
    `Start-Sleep -Seconds ${s}`,
  ].join("; ");
}

/** How to start that PowerShell: hidden, on its own, outliving the app. */
export function keepAwakeSpawn(seconds = UPDATE_AWAKE_SECONDS) {
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      keepAwakeScript(seconds),
    ],
    options: { detached: true, stdio: "ignore" as const, windowsHide: true },
  };
}
