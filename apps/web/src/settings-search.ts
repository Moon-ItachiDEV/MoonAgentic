// Kept apart from the settings view, so it is easy to test.

/** The sections whose name holds what was typed, accents and case aside. */
export function matchSections<T extends { label: string }>(sections: T[], query: string): T[] {
  const fold = (t: string) =>
    t
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const q = fold(query.trim());
  return q ? sections.filter((s) => fold(s.label).includes(q)) : sections;
}
