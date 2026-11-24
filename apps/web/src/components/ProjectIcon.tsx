import type { Project } from "@moonagentic/protocol";
import { IconFolder } from "./icons.tsx";

/**
 * A project's icon: the emoji or letters set in its settings, on its tint, or the folder
 * while none is set.
 */
export function ProjectIcon(props: { project: Pick<Project, "icon" | "color">; size?: number }) {
  const size = props.size ?? 16;
  if (!props.project.icon) {
    // A tint alone colors the folder.
    return props.project.color ? (
      <span className={`pj-fold pc-${props.project.color}`} aria-hidden>
        <IconFolder size={size} />
      </span>
    ) : (
      <IconFolder size={size} />
    );
  }
  return (
    <span
      className={`pj-ico${props.project.color ? ` pc-${props.project.color}` : ""}`}
      style={{ width: size + 2, height: size + 2, fontSize: Math.round(size * 0.68) }}
      aria-hidden
    >
      {props.project.icon}
    </span>
  );
}
