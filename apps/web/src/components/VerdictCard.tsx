import { Fragment, useState } from "react";
import type { Verdict, VerdictPoint } from "../review-verdict.ts";
import { I } from "../v2/I.tsx";

const count = (n: number, one: string, many: string) => (n ? [`${n} ${n > 1 ? many : one}`] : []);

function Point({ point, tone }: { point: VerdictPoint; tone: "err" | "warn" | "note" }) {
  return (
    <div className={`fd ${tone}`}>
      <i />
      <span>{point.text}</span>
      {point.where && <em>{point.where}</em>}
    </div>
  );
}

/** A review an agent ended its answer with: its verdict, the blocking points, the checks. */
export function VerdictCard({ verdict }: { verdict: Verdict }) {
  const [more, setMore] = useState(false);
  const rest = [
    ...count(verdict.important.length, "important", "importants"),
    ...count(verdict.notes.length, "remarque", "remarques"),
  ];
  const counts = [...count(verdict.blocking.length, "bloquant", "bloquants"), ...rest];
  return (
    <div className="rv">
      <div className="rvh">
        <span className={`tg ${verdict.ready ? "ok" : "err"}`}>
          {verdict.ready ? "Prête" : "À corriger"}
        </span>
        {counts.length > 0 && (
          <span className="rvc">
            {counts.map((c, i) => {
              const [n, ...word] = c.split(" ");
              return (
                <Fragment key={c}>
                  {i > 0 && " · "}
                  <b>{n}</b> {word.join(" ")}
                </Fragment>
              );
            })}
          </span>
        )}
      </div>
      {verdict.blocking.map((p, i) => (
        <Point key={`b${i}`} point={p} tone="err" />
      ))}
      {rest.length > 0 && (
        <>
          <button
            className={`rvm press${more ? " on" : ""}`}
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            <I n="down" s={14} />
            {rest.join(" · ")}
          </button>
          {more && (
            <div className="rvmore">
              {verdict.important.map((p, i) => (
                <Point key={`i${i}`} point={p} tone="warn" />
              ))}
              {verdict.notes.map((p, i) => (
                <Point key={`n${i}`} point={p} tone="note" />
              ))}
            </div>
          )}
        </>
      )}
      {verdict.checks.map((c, i) => (
        <div key={`c${i}`} className={`ck${c.ok ? "" : " no"}`}>
          <I n={c.ok ? "check" : "x"} s={14} />
          {c.text}
        </div>
      ))}
    </div>
  );
}
