// Frontend crash forwarding and diagnostic export helpers: captures uncaught browser/React
// errors (throttled and deduplicated) so the server writes them into the daily log, and
// provides clipboard copy (with HTTP fallback for LAN phones) plus .txt download.
import { connection } from "./connection.ts";

export interface UiErrorReport {
  source: string;
  message: string;
  stack?: string;
  route?: string;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const DEDUP_MS = 15_000;
const IGNORED = /^ResizeObserver loop/i;

/** Formats any thrown value into a concise message + optional clipped stack. */
export function normalizeUiError(
  error: unknown,
  extraStack?: string | null,
): { message: string; stack?: string } {
  let message: string;
  let stack: string | undefined;
  if (error instanceof Error) {
    message = error.message || error.name || "Erreur inconnue";
    stack = error.stack;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  const parts: string[] = [];
  if (extraStack?.trim()) parts.push(extraStack.trim().slice(0, 500));
  if (stack?.trim()) parts.push(stack.trim().slice(0, 1000));
  const combined = parts.join("\n");
  return {
    message: message.trim().slice(0, 400),
    ...(combined ? { stack: combined.slice(0, 1500) } : {}),
  };
}

/** Creates a throttled, deduplicated error reporter (pure factory for easy testing). */
export function createUiErrorReporter(
  send: (report: UiErrorReport) => void,
  options?: { now?: () => number; route?: () => string | undefined },
): (source: string, error: unknown, extraStack?: string | null) => boolean {
  const now = options?.now ?? Date.now;
  const route =
    options?.route ?? (() => (typeof location !== "undefined" ? location.pathname : undefined));
  const sentAt: number[] = [];
  let lastKey = "";
  let lastAt = 0;

  return (source, error, extraStack) => {
    const normalized = normalizeUiError(error, extraStack);
    if (!normalized.message || IGNORED.test(normalized.message)) return false;
    const at = now();
    while (sentAt.length > 0 && at - sentAt[0]! > WINDOW_MS) sentAt.shift();
    if (sentAt.length >= MAX_PER_WINDOW) return false;
    const key = `${source}:${normalized.message}`;
    if (key === lastKey && at - lastAt < DEDUP_MS) return false;
    sentAt.push(at);
    lastKey = key;
    lastAt = at;
    try {
      const currentRoute = route();
      send({
        source,
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {}),
        ...(currentRoute ? { route: currentRoute } : {}),
      });
      return true;
    } catch {
      return false;
    }
  };
}

export const reportUiError = createUiErrorReporter((report) => {
  connection.reportClientError(report);
});

let handlersInstalled = false;

/** Installs global window `error` and `unhandledrejection` handlers once. */
export function installGlobalErrorHandlers(): void {
  if (handlersInstalled || typeof window === "undefined") return;
  handlersInstalled = true;
  window.addEventListener("error", (event: ErrorEvent) => {
    const err =
      event.error ??
      (event.message
        ? new Error(
            event.filename
              ? `${event.message} (${event.filename}:${event.lineno}:${event.colno})`
              : event.message,
          )
        : null);
    if (err) reportUiError("window", err);
  });
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    reportUiError("promise", event.reason);
  });
}

/** Copies text to clipboard, falling back to a temporary textarea on plain HTTP origins. */
export async function copyDiagnosticText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback (common on plain HTTP LAN tabs).
    }
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}

/** Triggers a plain-text download of the diagnostic report. */
export function downloadDiagnosticText(text: string, generatedAt = Date.now()): void {
  if (typeof document === "undefined") return;
  const d = new Date(generatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `moonagentic-diagnostic-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
