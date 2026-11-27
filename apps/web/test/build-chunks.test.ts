import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createLogger } from "vite";
import { describe, expect, it } from "vitest";
import webConfig from "../vite.config.ts";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const MAX_CHUNK_BYTES = 500 * 1024;

type BuiltOutput = {
  output: Array<
    | {
        type: "chunk";
        fileName: string;
        name: string;
        code: string;
        isEntry: boolean;
        isDynamicEntry: boolean;
        facadeModuleId: string | null;
        imports: string[];
        dynamicImports: string[];
        exports: string[];
      }
    | {
        type: "asset";
        fileName: string;
        source: string | Uint8Array;
      }
  >;
};

describe("web production build chunks", () => {
  it("splits Planner and Settings into on-demand chunks with no chunk over 500 kB", async () => {
    // The 500 kB warning must be fixed by splitting code, not silenced by raising the limit.
    const config = typeof webConfig === "function" ? null : webConfig;
    expect(config?.build?.chunkSizeWarningLimit).toBeUndefined();

    const warnings: string[] = [];
    const baseLogger = createLogger("warn");
    const customLogger = {
      ...baseLogger,
      info: () => undefined,
      warn: (msg: string) => {
        warnings.push(msg);
      },
      warnOnce: (msg: string) => {
        warnings.push(msg);
      },
    };

    const result = (await build({
      configFile: path.resolve(webDir, "vite.config.ts"),
      root: webDir,
      build: { write: false },
      customLogger,
    })) as BuiltOutput | BuiltOutput[];

    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
    const chunks = outputs.filter((item) => item.type === "chunk");
    const htmlAsset = outputs.find(
      (item) => item.type === "asset" && item.fileName === "index.html",
    );

    expect(
      warnings.filter((w) => /larger than \d+ kB|chunkSizeWarningLimit/i.test(w)),
      "Vite should not warn about oversized chunks",
    ).toEqual([]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = Buffer.byteLength(chunk.code, "utf8");
      expect(bytes, `${chunk.fileName} is ${bytes} bytes`).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }

    const entry = chunks.find((c) => c.isEntry);
    expect(entry, "main entry chunk should exist").toBeDefined();

    const plannerChunks = chunks.filter((c) =>
      c.facadeModuleId?.replace(/\\/g, "/").endsWith("/components/Planner.tsx"),
    );
    const settingsChunks = chunks.filter((c) =>
      c.facadeModuleId?.replace(/\\/g, "/").endsWith("/components/Settings.tsx"),
    );

    expect(plannerChunks).toHaveLength(1);
    expect(settingsChunks).toHaveLength(1);

    const planner = plannerChunks[0]!;
    const settings = settingsChunks[0]!;

    expect(planner.isEntry).toBe(false);
    expect(planner.isDynamicEntry).toBe(true);
    expect(settings.isEntry).toBe(false);
    expect(settings.isDynamicEntry).toBe(true);
    // The whole settings screen, list and pages, is one chunk.
    expect(settings.exports).toEqual(expect.arrayContaining(["SettingsLayer"]));

    // Neither chunk is statically imported by the entry; both are dynamically imported.
    expect(entry!.imports).not.toContain(planner.fileName);
    expect(entry!.imports).not.toContain(settings.fileName);
    expect(entry!.dynamicImports).toContain(planner.fileName);
    expect(entry!.dynamicImports).toContain(settings.fileName);

    // index.html must not eagerly load or preload the on-demand chunks.
    expect(htmlAsset).toBeDefined();
    const html =
      typeof htmlAsset!.source === "string"
        ? htmlAsset!.source
        : Buffer.from(htmlAsset!.source).toString("utf8");
    expect(html).not.toContain(planner.fileName);
    expect(html).not.toContain(settings.fileName);

    // The update's card comes on demand with its own styles: the page's stylesheet holds the
    // capsule that announces a version (on every page), not the card.
    const styles = outputs
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) => ({
        fileName: item.fileName,
        css:
          item.type === "asset" && typeof item.source === "string"
            ? item.source
            : Buffer.from((item as { source: Uint8Array }).source).toString("utf8"),
      }));
    const pageStyles = styles
      .filter((style) => html.includes(style.fileName))
      .map((style) => style.css)
      .join("\n");
    expect(pageStyles).toContain(".useg");
    expect(pageStyles).not.toContain(".ucard");
    const cardStyles = styles.filter((style) => style.css.includes(".ucard"));
    expect(cardStyles).toHaveLength(1);
    expect(html).not.toContain(cardStyles[0]!.fileName);
  });
});
