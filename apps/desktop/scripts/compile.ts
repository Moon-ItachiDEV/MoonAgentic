// Turns the shell's TypeScript into the JavaScript Electron starts, in `dist/`.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isTest, stripDir } from "./strip.ts";

const src = fileURLToPath(new URL("../src", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
rmSync(dist, { recursive: true, force: true });
stripDir(src, dist, isTest);
