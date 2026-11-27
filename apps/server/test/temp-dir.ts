import { rmSync } from "node:fs";

/**
 * Removes a test's temporary folder. On a Windows runner held up by the other test files, a
 * file just closed stayed locked longer than the retries (EPERM, main's CI on 2026-11-27): the
 * folder is then left to the runner, and fails no test. That the server itself lets go of its
 * files is checked apart, in checkpoints.test.ts (« a closed database »).
 */
export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw error;
    console.warn(`Dossier temporaire laissé : ${dir} (${code})`);
  }
}
