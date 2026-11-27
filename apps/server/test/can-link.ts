import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * True when this system lets a test make a symbolic link. Windows allows it to an
 * administrator or in Developer Mode, as on the CI runner: the tests of links then run there
 * too, and are left out only on a computer that refuses them.
 */
export const canLink = (() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonagentic-link-probe-"));
  try {
    writeFileSync(path.join(dir, "a"), "");
    symlinkSync(path.join(dir, "a"), path.join(dir, "b"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
