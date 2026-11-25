import type { ImageDraft } from "../use-image-drafts.ts";
import { I } from "../v2/I.tsx";

/** The images joined to the message being written, each with a way to take it off. */
export function ComposerImages(props: { drafts: ImageDraft[]; onRemove: (key: string) => void }) {
  if (!props.drafts.length) return null;
  return (
    <ul className="att" aria-label="Images jointes">
      {props.drafts.map((draft) => (
        <li key={draft.key} className={draft.image ? "th" : "th sending"}>
          {draft.preview && <img src={draft.preview} alt={draft.name} title={draft.name} />}
          {!draft.image && (
            <span className="th-wait" role="status" aria-label={`Envoi de ${draft.name}`} />
          )}
          <button
            aria-label={`Retirer ${draft.name}`}
            title="Retirer"
            onClick={() => props.onRemove(draft.key)}
          >
            <I n="x" s={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
