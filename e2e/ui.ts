// Steps every browser check starts with, written once: they follow the app's screens.
import type { Page } from "playwright";

/**
 * « Nouveau projet » on a folder of this machine, then « Nouveau fil »: the composer of a new
 * thread in that project. The project's own page talks to its coordinator, not to an agent.
 */
export async function addProject(page: Page, folder: string, thread = true) {
  await page.getByRole("button", { name: "Nouveau projet" }).first().click();
  await page.getByRole("button", { name: "Autre dossier" }).click();
  await page.getByLabel("Dossier", { exact: true }).fill(folder);
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await page.waitForURL(/\/p\//);
  if (thread) await page.getByRole("button", { name: "Nouveau fil" }).first().click();
}

/** The composer's model menu, opened on every agent, set on the one named. */
export async function pickAgent(page: Page, name: RegExp = /^Agent de démo/) {
  await page.getByRole("combobox", { name: "Message" }).click();
  await page.getByRole("button", { name: /^Agent : / }).click();
  await page.getByRole("button", { name: "Plus", exact: true }).click();
  await page.getByRole("menuitemradio", { name }).click();
  await page.keyboard.press("Escape");
}

/** « Demande d'abord » or « Accès complet » for the next thread, from the composer's « + ». */
export async function setAccess(page: Page, name: RegExp) {
  await page.getByRole("combobox", { name: "Message" }).click();
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Plus" }).click();
  await page.getByRole("radio", { name }).click();
  await page.keyboard.press("Escape");
}
