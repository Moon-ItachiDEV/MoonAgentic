// Steps every browser check starts with, written once: they follow the app's screens.
import type { Locator, Page } from "playwright";
import { expect } from "vitest";

/**
 * « Nouveau projet » on a folder of this machine, then the composer of a new thread in that
 * project. The project's own page talks to its coordinator, not to an agent.
 */
export async function addProject(page: Page, folder: string, thread = true) {
  await page.getByRole("button", { name: "Nouveau projet" }).first().click();
  await page.getByRole("button", { name: "Autre dossier" }).click();
  await page.getByLabel("Dossier", { exact: true }).fill(folder);
  await createButton(page).click();
  await page.waitForURL(/\/p\//);
  if (thread) await directThread(page);
}

/**
 * The home composer, in the project last opened: a conversation straight with an agent. A
 * project's page has no « Nouveau fil », its threads are opened by its coordinator.
 */
export async function directThread(page: Page) {
  await page.goto(new URL("/", page.url()).href);
  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.waitFor();
  // Back on the server after the reload: until then it cannot be written in.
  await expect.poll(() => composer.isEnabled()).toBe(true);
}

/**
 * From the model's menu to every model: « Plus » in the phone's sheet, « Tous les modèles » in
 * the menu above the composer on wider screens.
 */
export const allModelsButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: /^(Plus|Tous les modèles)$/ });

/** In the menu above the composer, the agents are folded under one row: it is opened. */
export async function showAgents(all: Locator) {
  const fold = all.getByRole("button", {
    name: /^(Agent|Passer à un autre agent)\b/,
    expanded: false,
  });
  if (await fold.count()) await fold.click();
}

/** The composer's model menu, opened on every agent, set on the one named. */
export async function pickAgent(page: Page, name: RegExp = /^Agent de démo/) {
  await page.getByRole("combobox", { name: "Message" }).click();
  await page.getByRole("button", { name: /^Agent : / }).click();
  await allModelsButton(page).click();
  await showAgents(page.getByRole("dialog", { name: "Tous les modèles" }));
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

/** « Créer » in the phone's sheet, « Créer le projet » in the window of an iPad or a computer. */
export const createButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: /^Créer( le projet)?$/ });

/** « Cloner », or « Cloner le projet » in the window of an iPad or a computer. */
export const cloneButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: /^Cloner( le projet)?$/ });

/**
 * Where a new conversation is held: a sheet on a phone, a menu beside the « + » menu on an iPad
 * or a computer. Its lines are found by their text.
 */
export const whereChoices = (page: Page) => page.locator('[aria-label="Où travailler"]');
