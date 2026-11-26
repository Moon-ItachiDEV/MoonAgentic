import { describe, expect, it, vi } from "vitest";
import { renameKey, sendRename } from "./rename.ts";

describe("renaming a thread in its header", () => {
  // Neon's review of PR #176: offline, « Connexion coupée » was replaced by « Discussion renommée ».
  it("says it is renamed only when the name went", () => {
    const offline = { send: vi.fn(() => false), notify: vi.fn() };
    sendRename(offline, "t1", "Nouveau nom", true);
    expect(offline.send).toHaveBeenCalledWith({
      type: "thread.rename",
      threadId: "t1",
      title: "Nouveau nom",
    });
    expect(offline.notify).not.toHaveBeenCalled();
    const online = { send: vi.fn(() => true), notify: vi.fn() };
    sendRename(online, "t1", "Nouveau nom", true);
    expect(online.notify).toHaveBeenCalledWith("Discussion renommée");
    sendRename(online, "t2", "Autre", false);
    expect(online.notify).toHaveBeenLastCalledWith("Fil renommé");
  });

  // Same review: Enter or Esc that ends a composition (IME) is the composition's, not the field's.
  it("leaves Enter and Esc to a composition under way", () => {
    expect(renameKey({ key: "Enter", isComposing: true })).toBeUndefined();
    expect(renameKey({ key: "Escape", isComposing: true })).toBeUndefined();
    expect(renameKey({ key: "Enter", isComposing: false })).toBe("save");
    expect(renameKey({ key: "Escape", isComposing: false })).toBe("cancel");
    expect(renameKey({ key: "a", isComposing: false })).toBeUndefined();
  });
});
