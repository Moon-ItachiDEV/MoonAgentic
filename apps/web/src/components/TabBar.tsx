import type { Thread } from "@moonagentic/protocol";
import type { State } from "../state.ts";
import { IconBrackets, IconBubble, IconStack } from "./icons.tsx";

/**
 * The conversation whose changes the « Code » tab opens: the latest one with its own branch,
 * a conversation of yours before a team member's.
 */
export function codeThread(state: Pick<State, "threads">): Thread | undefined {
  const withCode = state.threads
    .filter((t) => t.workspace && !t.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return withCode.find((t) => !t.parentId) ?? withCode[0];
}

/** The phone's tabs on the home page, as in the mockup, with only what is real. */
export function TabBar(props: {
  state: State;
  onNew: () => void;
  onProjects: () => void;
  onCode: (threadId: string) => void;
}) {
  const code = codeThread(props.state);
  const waiting = props.state.requests.length > 0;
  return (
    <nav className="tabbar" aria-label="Sections">
      <button className="on" aria-current="page" onClick={props.onNew}>
        <IconBubble />
        <span className="tl">Nouveau</span>
      </button>
      <button onClick={props.onProjects}>
        <IconStack />
        <span className="tl">Projets</span>
        {waiting && <span className="bdg" aria-label="Un agent attend ta réponse" />}
      </button>
      <button
        disabled={!code}
        title={code ? `Modifications de « ${code.title} »` : "Aucune modification à revoir"}
        onClick={() => code && props.onCode(code.id)}
      >
        <IconBrackets />
        <span className="tl">Code</span>
      </button>
    </nav>
  );
}
