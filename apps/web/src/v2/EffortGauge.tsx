import type { AgentSetting } from "@moonagentic/protocol";
import { effortName } from "../effort.ts";

/**
 * A reasoning level as marks, the one chosen standing tall (as on the model wheel), with its
 * name when `named`; the highest, « UltraMoon », takes the galaxy's ink.
 */
export function EffortGauge(props: { setting: AgentSetting; value: string; named?: boolean }) {
  const { setting } = props;
  const levels = setting.choices.length;
  const level = Math.max(
    0,
    setting.choices.findIndex((c) => c.id === props.value),
  );
  const top = levels > 1 && level === levels - 1;
  return (
    <span className={`tme${top ? " gx" : ""}`} aria-hidden="true">
      <span
        className="mg"
        style={
          {
            "--mp": `${levels > 1 ? Math.round((level / (levels - 1)) * 100) : 0}%`,
          } as React.CSSProperties
        }
      >
        {setting.choices.map((c, k) => (
          <i key={c.id} className={k === level ? "t" : undefined} />
        ))}
      </span>
      {props.named && <span className="el">{effortName(setting, level)}</span>}
    </span>
  );
}
