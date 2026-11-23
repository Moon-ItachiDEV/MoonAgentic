// How remote access is described to the user: pure, so it is easy to test.
import type { RemoteAccess, RemoteAddress } from "@moonagentic/protocol";

/** The link another device opens: the address, then the token in the fragment (never sent in HTTP). */
export const remoteLink = (address: RemoteAddress, token: string) =>
  `${address.url}/#token=${encodeURIComponent(token)}`;

/** What kind of address this is, and what it means for who can read the traffic. */
export function addressText(address: RemoteAddress): {
  tone: "ok" | "warn";
  label: string;
  detail: string;
} {
  if (address.public) {
    return {
      tone: "warn",
      label: "Tailscale Funnel",
      detail:
        "Funnel est actif : cette adresse répond à tout Internet, pas seulement à tes appareils. Seul le jeton protège l'accès.",
    };
  }
  if (address.kind === "tailscale-https") {
    return {
      tone: "ok",
      label: "Tailscale (HTTPS)",
      detail: "Chiffré, et réservé aux appareils connectés à ton réseau Tailscale.",
    };
  }
  if (address.kind === "tailscale") {
    return {
      tone: "ok",
      label: "Tailscale",
      detail:
        "Réservé aux appareils connectés à ton réseau Tailscale. En HTTP simple, le navigateur refuse les notifications : préfère tailscale serve.",
    };
  }
  return {
    tone: "warn",
    label: "Réseau local",
    detail:
      "Sans chiffrement : à n'utiliser que sur un réseau de confiance, comme le Wi-Fi de la maison.",
  };
}

/** The command that publishes MoonAgentic on the Tailscale network, over HTTPS. */
export const serveCommand = (port: number) => `tailscale serve --bg ${port}`;

/**
 * What to do when no address works yet, or how to get a better one. Nothing when the best
 * address is already there.
 */
export function remoteAdvice(access: RemoteAccess): { text: string; command?: string } | null {
  if (access.addresses.some((a) => a.kind === "tailscale-https")) return null;
  if (access.tailscale === "ready") {
    return {
      text: access.addresses.length
        ? "Pour une adresse en HTTPS, lance cette commande sur cette machine, puis Actualiser :"
        : `Tailscale est connecté${access.tailscaleName ? ` (${access.tailscaleName})` : ""}, mais MoonAgentic n'y est pas encore publié. Lance cette commande sur cette machine, puis Actualiser :`,
      command: serveCommand(access.port),
    };
  }
  if (access.tailscale === "stopped") {
    return {
      text: "Tailscale est installé mais pas connecté. Ouvre Tailscale sur cette machine et connecte-toi, puis Actualiser.",
    };
  }
  if (access.addresses.length) {
    return {
      text: "Tailscale n'est pas installé sur cette machine. Avec lui, l'accès est chiffré et marche aussi hors de chez toi : https://tailscale.com/download",
    };
  }
  return {
    text: "MoonAgentic n'écoute que sur cette machine, et Tailscale n'y est pas installé. Installe Tailscale (https://tailscale.com/download), ou relance MoonAgentic avec --host 0.0.0.0 pour l'ouvrir au réseau local.",
  };
}
