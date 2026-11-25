import { useState } from "react";
import { MoonMark } from "./MoonMark.tsx";

/** « Bonsoir » from 18 h until the small hours, « Bonjour » the rest of the day. */
export const greeting = (hour: number) => (hour >= 18 || hour < 5 ? "Bonsoir" : "Bonjour");

const LINES = {
  night: [
    "On code sous la lune ?",
    "La lune veille, on s’y met ?",
    "Encore une idée avant de dormir ?",
  ],
  evening: [
    "Quoi de beau ce soir ?",
    "Une petite mission pour ce soir ?",
    "On construit quoi ce soir ?",
  ],
  morning: [
    "Un café et on s’y met ?",
    "On démarre quoi ce matin ?",
    "Nouvelle journée, nouvelle idée ?",
  ],
  afternoon: [
    "On avance sur quoi ?",
    "Qu’est-ce qu’on construit aujourd’hui ?",
    "Une idée à faire décoller ?",
  ],
} as const;

/** The part of the day an hour falls in, for the line the home page greets with. */
export const dayPart = (hour: number): keyof typeof LINES =>
  hour >= 22 || hour < 5 ? "night" : hour >= 18 ? "evening" : hour < 12 ? "morning" : "afternoon";

/** The home page's line: one of three for the part of the day, the same while the page stays open. */
export const greetLine = (hour: number, pick: number): string => {
  const lines = LINES[dayPart(hour)];
  return lines[Math.abs(Math.trunc(pick)) % lines.length]!;
};

/** The home page: the mark and a line, above the composer. */
export function Home({ loading }: { loading?: boolean }) {
  const [pick] = useState(() => Math.floor(Math.random() * 3));
  return (
    <div className="view" id="view">
      <div className="gstack" id="gstack">
        <div className="greet gp on">
          <MoonMark className="mk" />
          <h1>{loading ? "Chargement…" : greetLine(new Date().getHours(), pick)}</h1>
        </div>
      </div>
      <div className="end" />
    </div>
  );
}
