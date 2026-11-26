import { ROLE_COLORS, ROLE_PHASES, type RoleMascot } from "@moonagentic/protocol";
import { useEffect, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { I } from "../v2/I.tsx";
import { Masc, type MascJob, useMascLook } from "../v2/Masc.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import type { FrostMoonState } from "./FrostMoon.tsx";

const GROUPS: [string, [MascJob, string][]][] = [
  [
    "Équipe",
    [
      ["chef", "Chef"],
      ["code", "Codeurs"],
      ["relit", "Relecture"],
      ["tests", "Tests"],
      ["fusion", "Fusion"],
    ],
  ],
  [
    "Revue",
    [
      ["rev", "Relecteurs"],
      ["arb", "Arbitre"],
    ],
  ],
];

const PHASE_NAME: Record<RoleMascot["phase"], string> = {
  crescent: "Croissant",
  full: "Pleine lune",
  star: "Étoile",
  planet: "Planète",
  chef: "Chef",
};

/** Each tint with its name and the two colours of its swatch. */
const TINT: Record<RoleMascot["color"], [string, string, string]> = {
  moon: ["Moon", "#d3dfff", "#86a0ff"],
  violet: ["Violet", "#e6d6ff", "#b48aff"],
  gold: ["Or", "#fef0be", "#fbcb52"],
  blue: ["Blue", "#c8eeff", "#6cd0ff"],
  orange: ["Orange", "#ffddc8", "#ff9d64"],
  emerald: ["Émeraude", "#c6f9e4", "#5ee3b0"],
  rose: ["Rose", "#ffd6eb", "#fb8cc2"],
  crimson: ["Carmin", "#ffd4d8", "#ff7a88"],
  silver: ["Argent", "#e6ecf4", "#b0bfd4"],
};

/** The faces a mascot makes, each from what its role really does. */
const FACES: [FrostMoonState, string][] = [
  ["repos", "Repos"],
  ["demarre", "Démarre"],
  ["pense", "Pense"],
  ["cherche", "Cherche"],
  ["lit", "Lit"],
  ["ecrit", "Écrit"],
  ["modifie", "Modifie"],
  ["commande", "Commande"],
  ["tests", "Tests"],
  ["web", "Web"],
  ["travaille", "Travaille"],
  ["attend", "Attend"],
  ["file", "File"],
  ["termine", "Terminé"],
  ["erreur", "Erreur"],
];

function RoleRow({ job, label, onOpen }: { job: MascJob; label: string; onOpen: () => void }) {
  const look = useMascLook(job);
  return (
    <button className="it mjr" onClick={onOpen}>
      <span className="mjm">
        <Masc job={job} state="travaille" />
      </span>
      <span className="tx">{label}</span>
      <span className="rt">
        {TINT[look.color][0]}
        <I n="right" s={15} />
      </span>
    </button>
  );
}

/** The faces, on a wheel that snaps: the one in the middle is shown on the moon beside it. */
function FaceWheel({
  face,
  onFace,
}: {
  face: FrostMoonState;
  onFace: (f: FrostMoonState) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const i = FACES.findIndex(([f]) => f === face);
    el.scrollTop = i * 48;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const at = Math.round(el.scrollTop / 48);
        const next = FACES[Math.max(0, Math.min(FACES.length - 1, at))]![0];
        onFace(next);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
    // Placed once when the sheet opens; the wheel then leads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="xw" aria-label="Expression">
      <div className="wsel" />
      <div className="xl" ref={list}>
        {FACES.map(([f, name], i) => (
          <button
            key={f}
            className={`xi${f === face ? " c" : ""}`}
            onClick={() => list.current?.scrollTo({ top: i * 48, behavior: "smooth" })}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoleSheet({ job, label, onClose }: { job?: MascJob; label: string; onClose: () => void }) {
  const [face, setFace] = useState<FrostMoonState>("travaille");
  return (
    <Sheet open={!!job} onClose={onClose} title={label}>
      {job && <RoleSheetBody job={job} face={face} onFace={setFace} />}
    </Sheet>
  );
}

function RoleSheetBody({
  job,
  face,
  onFace,
}: {
  job: MascJob;
  face: FrostMoonState;
  onFace: (f: FrostMoonState) => void;
}) {
  const look = useMascLook(job);
  const set = (next: RoleMascot) => connection.send({ type: "roleMascots.set", job, look: next });
  return (
    <div className="sbody">
      <div className="mpw">
        <div className="mprev">
          <Masc job={job} state={face} />
        </div>
        <FaceWheel face={face} onFace={onFace} />
      </div>
      <div className="gl2">Forme</div>
      <div className="ins">
        <div className="msh" role="group" aria-label="Forme">
          {ROLE_PHASES.map((phase) => (
            <button
              key={phase}
              aria-pressed={look.phase === phase}
              onClick={() => set({ phase, color: look.color })}
            >
              <span>
                <Masc job={job} state="travaille" phase={phase} preview />
              </span>
              {PHASE_NAME[phase]}
            </button>
          ))}
        </div>
      </div>
      <div className="gl2">Teinte</div>
      <div className="ins">
        <div className="mtw" role="group" aria-label="Teinte">
          {ROLE_COLORS.map((color) => (
            <button
              key={color}
              aria-pressed={look.color === color}
              aria-label={TINT[color][0]}
              style={{ ["--g1" as string]: TINT[color][1], ["--g2" as string]: TINT[color][2] }}
              onClick={() => set({ phase: look.phase, color })}
            >
              <i />
              <span>{TINT[color][0]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Réglages › Mascottes: the moon of each role of a team and of a review, for every device. */
export function RoleMascots() {
  const [open, setOpen] = useState<MascJob>();
  const label = GROUPS.flatMap(([, list]) => list).find(([j]) => j === open)?.[1] ?? "";
  return (
    <>
      {GROUPS.map(([group, list]) => (
        <div key={group}>
          <div className="gl2">{group}</div>
          <div className="ins">
            {list.map(([job, name]) => (
              <RoleRow key={job} job={job} label={name} onOpen={() => setOpen(job)} />
            ))}
          </div>
        </div>
      ))}
      <RoleSheet job={open} label={label} onClose={() => setOpen(undefined)} />
    </>
  );
}
