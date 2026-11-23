import type { AgentInfo, Item, Thread } from "@moonagentic/protocol";

/** The thread as a Markdown document: messages, plans and tool steps, in order. */
export function threadMarkdown(thread: Thread, items: Item[], agents: AgentInfo[]): string {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  // Who wrote each agent message: the thread's agent, or the one it was handed over from.
  const authors: string[] = [];
  let author = thread.agentId;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "handoff") author = item.from;
    authors[i] = author;
  }
  const lines = [`# ${thread.title}`, ""];
  items.forEach((item, i) => {
    switch (item.kind) {
      case "user":
        lines.push(
          item.from === "coordinator"
            ? "## Coordinateur"
            : item.from === "goal"
              ? "## Objectif (relance automatique)"
              : "## Toi",
          "",
        );
        if (item.text) lines.push(item.text, "");
        // The export is text alone: an image is named, not carried.
        for (const image of item.images ?? []) lines.push(`*Image jointe : ${image.name}*`, "");
        return;
      case "agent":
        lines.push(`## ${name(authors[i] ?? thread.agentId)}`, "", item.text, "");
        return;
      case "plan":
        lines.push(
          "**Plan**",
          "",
          ...item.entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`),
          "",
        );
        return;
      case "tool":
        lines.push(`> ${item.status === "failed" ? "✗" : "✓"} ${item.title}`, "");
        return;
      case "handoff":
        lines.push(`*${name(item.from)} passe le relais à ${name(item.to)}.*`, "");
        return;
      case "opened":
        lines.push(`> Fil ouvert : ${item.title}`, "");
        return;
      case "result":
        lines.push(`> Résultat de « ${item.title} » : ${item.summary}`, "");
        return;
      case "thought":
      case "permission":
        return;
    }
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A file name made from the thread's title. */
export function exportFileName(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return `${slug || "discussion"}.md`;
}

/** Hands the browser a Markdown file to save. */
export function downloadMarkdown(fileName: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
