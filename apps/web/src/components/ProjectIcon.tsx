import type { Project } from "@moonagentic/protocol";
import { projectIconName } from "../project-icons.ts";
import { I } from "../v2/I.tsx";

/**
 * A project's icon: one of the project icons drawn in its tint, the emoji or letters set in
 * its settings on its tint, or its folder in its tint while none is set.
 */
export function ProjectIcon(props: { project: Pick<Project, "icon" | "color">; size?: number }) {
  const size = props.size ?? 16;
  const tint = props.project.color ? ` pc-${props.project.color}` : "";
  const drawn = projectIconName(props.project.icon);
  if (!props.project.icon || drawn) {
    return (
      <span className={`pj-fold${tint}`} aria-hidden>
        {drawn ? (
          <svg width={size} height={size} aria-hidden="true">
            <use href={`#pi-${drawn}`} />
          </svg>
        ) : (
          <I n="folder" s={size} />
        )}
      </span>
    );
  }
  return (
    <span
      className={`pj-ico${tint}`}
      style={{ width: size + 2, height: size + 2, fontSize: Math.round(size * 0.68) }}
      aria-hidden
    >
      {props.project.icon}
    </span>
  );
}
