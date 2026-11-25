import { lazy, Suspense, useSyncExternalStore } from "react";
import { connection } from "../connection.ts";
import type { FrostMoonColor, FrostMoonPhase, FrostMoonState } from "../components/FrostMoon.tsx";

// The moons are heavy drawings: they are fetched the first time a team or a review shows.
const FrostMoon = lazy(() =>
  import("../components/FrostMoon.tsx").then((m) => ({ default: m.FrostMoon })),
);

/** The work a mascot stands for, in a team or in a review. */
export type MascJob = "chef" | "code" | "relit" | "tests" | "fusion" | "rev" | "arb";

/** The role's look: the one the user picked in Réglages › Mascottes, else its own. */
export function useMascLook(job: MascJob): {
  phase: FrostMoonPhase;
  color: FrostMoonColor;
  own: boolean;
} {
  const saved = useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().roleMascots[job],
  );
  return saved ? { ...saved, own: false } : { ...MASC_LOOK[job], own: true };
}

/** One moon per kind of work: its shape says the role, its tint tells the roles apart. */
export const MASC_LOOK: Record<MascJob, { phase: FrostMoonPhase; color: FrostMoonColor }> = {
  chef: { phase: "chef", color: "gold" },
  code: { phase: "star", color: "moon" },
  relit: { phase: "crescent", color: "violet" },
  tests: { phase: "full", color: "emerald" },
  fusion: { phase: "planet", color: "blue" },
  rev: { phase: "crescent", color: "moon" },
  arb: { phase: "chef", color: "gold" },
};

const SAYS: Partial<Record<FrostMoonState, string>> = {
  repos: "Au repos",
  termine: "Terminé",
  erreur: "À corriger",
  file: "En attente",
  attend: "T'attend",
};

/**
 * A role's mascot, floating alone with no tile behind it. Its eyes say what the role really
 * does now; `state` comes from its thread, never from a made-up animation.
 */
export function Masc({
  job,
  state,
  phase,
}: {
  job: MascJob;
  state: FrostMoonState;
  /** Another shape than the job's own, to tell three reviewers apart. */
  phase?: FrostMoonPhase;
}) {
  const look = useMascLook(job);
  return (
    <span className={`msk fzm x-${state}`}>
      <Suspense fallback={null}>
        <FrostMoon
          // Three reviewers keep three shapes, until the user picks one for them.
          phase={look.own ? (phase ?? look.phase) : look.phase}
          color={look.color}
          state={state}
          size="100%"
          followPointer={false}
          label={SAYS[state] ?? "Au travail"}
        />
      </Suspense>
    </span>
  );
}
