import type { Project } from "@moonagentic/protocol";
import { I } from "../v2/I.tsx";

/**
 * A project's icon: the emoji or letters set in its settings, on its tint, or its folder in
 * its tint while none is set.
 */
export function ProjectIcon(props: { project: Pick<Project, "icon" | "color">; size?: number }) {
  const size = props.size ?? 16;
  const tint = props.project.color ? ` pc-${props.project.color}` : "";
  if (!props.project.icon) {
    return (
      <span className={`pj-fold${tint}`} aria-hidden>
        <I n="folder" s={size} />
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
