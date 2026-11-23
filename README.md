<p align="center">
  <img src="./apps/web/public/icon.svg" width="80" height="80" alt="Logo MoonAgentic" />
</p>

<h1 align="center">MoonAgentic</h1>

<p align="center">Le poste de pilotage open-source pour tes agents de code.</p>

<p align="center">
  <a href="#installation"><strong>Démarrer</strong></a> ·
  <a href="#ce-que-tu-obtiens">Fonctionnalités</a> ·
  <a href="#agents">Agents</a> ·
  <a href="#tourner-24h24">24h/24</a> ·
  <a href="#contribuer">Contribuer</a> ·
  <a href="./LICENSE">MIT</a>
</p>

MoonAgentic pilote les agents de code déjà installés sur ta machine depuis une seule interface rapide. Lance un fil isolé, confie un projet entier à son coordinateur ou déploie une équipe d'agents au bureau, puis suis l'avancement, relis les diffs et valide la suite depuis ton téléphone.

Il fonctionne avec Claude Code, Codex, Antigravity, Cursor, Hermes et n'importe quel agent compatible ACP. Si un agent est configuré sur ton ordinateur, MoonAgentic peut le piloter.

## Ce que tu obtiens

- **Tes abonnements, ta machine.** MoonAgentic ne revend aucun jeton et ne voit jamais tes identifiants. Il lance directement les agents auxquels tu es déjà connecté.
- **Tous tes agents au même endroit.** Change de modèle en plein fil, épingle tes favoris, règle le mode ou le niveau de raisonnement, réponds aux cartes interactives (`ask_question`) et passe la main d'un agent à un autre avec relais d'historique.
- **Page Projet.** Chaque projet a sa vue dédiée (`/p/<id>`) qui regroupe les fils par état réel (**En attente**, **En cours**, **Inactif**, **Résolu**), avec projets épinglés, badges non lus, « Tout marquer comme lu » et mise en sourdine des notifications par projet.
- **Coordinateur par projet.** Active un coordinateur optionnel relié à MoonAgentic par un pont MCP `stdio` interne limité au loopback (jeton d'amorçage à usage unique, borné à ce projet). Il route chaque fil selon le type de travail (**Par défaut** — qui retient ton dernier choix manuel —, **Question**, **Bug**, **Fonctionnalité**, **Relecture**, **Tests**), met les fils en trop dans une file persistée (**Fils en même temps**, défaut `3`, `1–6`), remonte les résultats sans se réveiller et s'ouvre côte à côte avec n'importe quel fil (`/p/<projet>/f/<fil>`) et un onglet **Contexte**.
- **Équipes d'agents (`/equipe`).** Un **Chef** découpe la tâche, des **Codeurs** avancent en parallèle sur des branches isolées, **Relecteur** et **Testeur** contrôlent chaque morceau, puis le **Fusionneur** réunit le tout et peut ouvrir la pull request automatiquement. Quatre préréglages prêts à l'emploi (**Équilibrée**, **Économique**, **Qualité max**, **Neon relit et teste**), un fil d'équipe calme avec frise en direct et une synchronisation automatique avec le Planner.
- **Git intégré, Revue & GitHub.** Worktree et branche isolés par fil (**Branche à part**), checkpoints automatiques avant chaque tour (**Revenir ici**), panneau **Code** (onglet **Modifications**) avec commentaires ancrés par ligne de code et décochage automatique des fichiers sensibles (`.env`, `*.pem`, `*.key`, `.npmrc`…), commit/push/PR en un clic. Avec `gh`, clone tes dépôts GitHub depuis l'interface, suis l'état des PR, CI et conflits en direct et merge sans quitter MoonAgentic.
- **Planner & tâches planifiées (`/planifier`).** Tableau Kanban à 5 colonnes (**À faire**, **En cours**, **Reporté**, **En test**, **Livré**) mêlant tes cartes et celles pilotées par les équipes, vue **Timeline** (semaines/mois) et tâches ponctuelles ou récurrentes (une seule fois, toutes les heures, tous les jours, du lundi au vendredi ou toutes les semaines) avec rattrapage unique au redémarrage.
- **Composer complet.** Commandes `/` (même en milieu de message) + commandes projet dans `.moonagentic/commands/*.md`, mentions `@` de fichiers (respectant `.gitignore`), skills `$` détectés dans le projet et ton dossier utilisateur, dictée vocale (HTTPS ou `localhost`), recherche rapide (`Ctrl K` / `⌘ K`), jauge de contexte, `/compact` et export Markdown.
- **Serveurs MCP centralisés.** Déclare tes serveurs MCP (`stdio` ou HTTP) une seule fois dans **Réglages → Serveurs MCP** : ils sont transmis à tous les agents compatibles pendant que leurs secrets (variables d'environnement et en-têtes) restent strictement sur ton serveur local.
- **Bureau, téléphone & 24h/24.** Un seul serveur local synchronisé en temps réel (PWA iOS/Android, barre latérale repliable), file **À traiter** pour toutes les demandes d'accord, accès distant Tailscale ou LAN avec QR code, superviseur auto-relancé, sauvegardes SQLite quotidiennes et reconnexion mobile fiable.
- **Ouvert et local.** Sous licence MIT, protégé par jeton local, construit sur Node.js et SQLite sans dépendance lourde. Si quelque chose ne te convient pas, forke-le.

## Installation

Prérequis : **Node.js ≥ 22.18** (Node 24 recommandé), **pnpm 10+** et **git**. En option : **`gh`** (clonage GitHub, ouverture/suivi CI/merge de PR) et **[Tailscale](https://tailscale.com/download)** (accès chiffré en HTTPS depuis ton téléphone).

### Lancer en local

```bash
git clone https://github.com/Moon-ItachiDEV/MoonAgentic.git
cd MoonAgentic
pnpm install
pnpm build
pnpm start
```

Ouvre le lien affiché dans le terminal (`http://127.0.0.1:4747/#token=…`).

Pour passer une option au démarrage, utilise `pnpm start <options>` ou lance directement `node apps/server/src/bin.ts <options>` :

| Option CLI / Variable                      | Défaut           | Effet                                                                                           |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------- |
| `--port <n>` / `MOONAGENTIC_PORT`          | `4747`           | Port d'écoute HTTP/WebSocket (`0` choisit un port libre ; aussi lu par le proxy Vite).          |
| `--host <addr>`                            | `127.0.0.1`      | Adresse d'écoute (`0.0.0.0` expose le serveur sur le réseau local, sans chiffrement).           |
| `--data-dir <chemin>` / `MOONAGENTIC_HOME` | `~/.moonagentic` | Dossier privé contenant le jeton, la base SQLite, les worktrees, journaux et sauvegardes.       |
| `--demo`                                   | désactivé        | Ajoute deux agents simulés hors-ligne pour tester toute l'interface gratuitement.               |
| `--dev`                                    | désactivé        | Mode développement sans superviseur, agents de démo actifs, interface servie par Vite (`5173`). |
| `MOONAGENTIC_DEV_HOST`                     | `127.0.0.1`      | Hôte d'écoute du serveur Vite lancé par `pnpm dev`.                                             |

### Essayer sans compte ni clé

```bash
node apps/server/src/bin.ts --demo
```

Ajoute deux agents simulés hors-ligne pour tester gratuitement le streaming, les coordinateurs, les équipes, les diffs commentés, MCP et le passage de relais.

### Accès depuis un téléphone

**Réglages → Accès distant** affiche l'adresse à ouvrir depuis un autre appareil, le lien avec jeton et son QR code à scanner. La page détecte Tailscale toute seule ; sans lui, elle propose l'adresse du réseau local si tu as lancé le serveur avec `--host 0.0.0.0` :

```bash
node apps/server/src/bin.ts --host 0.0.0.0
```

Sans Tailscale, le trafic n'est pas chiffré : reste sur un réseau de confiance, et note que **les notifications navigateur et la dictée vocale exigent HTTPS** (ou `localhost`). Si un lien a pu fuiter, **Renouveler le jeton** coupe immédiatement toutes les anciennes sessions.

## Tourner 24h/24

### App de bureau (Windows, Mac)

L'app de bureau lance le même serveur et la même interface, dans une fenêtre, avec une icône près de l'horloge (dans la barre de menus sur Mac). Fermer la fenêtre ne l'arrête pas : tes agents continuent, l'icône la rouvre. Elle n'a pas besoin de Node.js ni de pnpm.

- **Télécharger** : dans [Releases](https://github.com/Moon-ItachiDEV/MoonAgentic/releases), `MoonAgentic-<version>-windows-x64.exe` (Windows 11) ou `MoonAgentic-<version>-mac-arm64.dmg` (Mac Apple Silicon).
- **Pas encore signée** : sur Windows, SmartScreen affiche « Windows a protégé votre ordinateur » → **Informations complémentaires → Exécuter quand même**. Sur Mac, fais un clic droit sur l'app → **Ouvrir** la première fois ; si macOS dit qu'elle est endommagée, lance `xattr -cr /Applications/MoonAgentic.app` dans un terminal.
- **Menu de l'icône** : **Lancer avec Windows** (ou **Ouvrir à la connexion** sur Mac) la démarre cachée à l'ouverture de session ; **Empêcher la mise en veille** (activé par défaut) garde l'ordinateur éveillé tant qu'elle tourne ; **Redémarrer le serveur**, **Ouvrir le dossier des journaux**, **Ouvrir dans le navigateur** et **Quitter MoonAgentic**, qui arrête d'abord les agents.
- **Mêmes données que `pnpm start`** : `~/.moonagentic` (jeton, fils, réglages) et le port `4747`. Ne lance pas les deux en même temps : l'app attend que le port se libère et réessaie seule. `tailscale serve --bg 4747` marche tel quel.
- **Pas de mise à jour automatique** : télécharge la nouvelle version et installe-la par-dessus.

Pour publier une version : monte `version` dans `apps/desktop/package.json`, puis pousse le tag correspondant (`git tag v0.1.0 && git push origin v0.1.0`). Le workflow **Desktop** construit les deux installeurs et les attache à la Release. Pour essayer l'app depuis un clone : `pnpm build`, puis `pnpm --filter @moonagentic/desktop dev`.

### Mini-PC Windows 11 + Tailscale

Un mini-PC garde tes agents en marche ; ton PC principal et ton téléphone s'y connectent en HTTPS par [Tailscale](https://tailscale.com/download), sans ouvrir de port sur ta box.

1. **Sur le mini-PC**, installe Node.js, pnpm, git, tes agents (connectés une fois à la main) et MoonAgentic comme ci-dessus. Installe Tailscale et connecte-toi ; fais de même sur ton PC principal et ton téléphone avec le même compte.
2. **Lance MoonAgentic** (`pnpm start` ou `node apps/server/src/bin.ts`). Il reste sur `127.0.0.1` : inutile d'ajouter `--host`.
3. **Publie-le sur ton réseau Tailscale**, une fois pour toutes, dans un terminal du mini-PC :

   ```powershell
   tailscale serve --bg 4747
   ```

   Si `tailscale` n'est pas reconnu, utilise `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 4747`. La première fois, Tailscale peut te demander d'activer HTTPS pour ton réseau : suis le lien qu'il affiche.

4. **Ouvre Réglages → Accès distant** sur le mini-PC : l'adresse `https://<mini-pc>.<ton-réseau>.ts.net` y apparaît avec son QR code. Scanne-le avec ton téléphone, copie le lien sur ton PC principal, puis ajoute la page à l'écran d'accueil.
5. **Pour qu'il tourne sans toi** : le plus simple est l'[app de bureau](#app-de-bureau-windows-mac) avec **Lancer avec Windows** et **Empêcher la mise en veille** cochés. Sans elle : dans Windows, _Paramètres → Système → Alimentation_, mets la mise en veille sur « Jamais ». Pour lancer MoonAgentic à chaque ouverture de session, fais `Win + R`, tape `shell:startup`, et crée `MoonAgentic.cmd` (remplace le chemin par celui de ton clone) :

   ```bat
   @echo off
   cd /d "C:\chemin\vers\MoonAgentic"
   node apps/server/src/bin.ts
   ```

   Appeler directement `node apps/server/src/bin.ts` évite de garder un processus `pnpm` résident en plus du superviseur. Évite une tâche planifiée `schtasks` : Windows coupe par défaut une tâche active depuis plus de 3 jours. Tailscale, lui, redémarre tout seul avec Windows et se souvient de `serve --bg`. Attention : `shell:startup` demande une session utilisateur ouverte — après un redémarrage Windows Update sans connexion automatique, MoonAgentic attendra ta réouverture de session. Sur un mini-PC Linux sans écran, un service utilisateur `systemd` avec `loginctl enable-linger` tourne sans session ouverte.

Pour être prévenu quand un fil attend ta réponse ou qu'une équipe a fini, active **Réglages → Général → Notifications** sur chaque appareil. Les notifications navigateur demandent HTTPS (`tailscale serve`) et un onglet ou une PWA active : il n'y a pas encore de Web Push en arrière-plan quand le téléphone est verrouillé.

N'utilise pas `tailscale funnel` : il ouvrirait MoonAgentic à tout Internet. **Réglages → Accès distant** te prévient si c'est le cas.

### Fiabilité en continu

- **Superviseur, journaux & sauvegardes.** `pnpm start` (via `bin.ts`) relance automatiquement le serveur s'il plante (backoff exponentiel de `1 s` à `60 s`), écrit des journaux quotidiens rotatifs jeton masqué dans `~/.moonagentic/logs/` (`14` jours gardés) et effectue chaque jour une copie SQLite atomique (`VACUUM INTO`) dans `~/.moonagentic/backups/` (`7` jours gardés). Au redémarrage, la file des fils en attente du coordinateur et les tâches planifiées échues reprennent automatiquement. Pour restaurer une copie : arrête MoonAgentic, remplace `~/.moonagentic/state.sqlite` par le fichier de sauvegarde et supprime `state.sqlite-wal` et `state.sqlite-shm` à côté.
- **Pool d'agents & anti-blocage.** Les agents inactifs passent automatiquement en veille après `10 min` (pool maximal de `8` agents vivants, session reprise au tour suivant). Cliquer **Arrêter** tue de force un agent figé après `10 s`. Un chien de garde signale un agent muet au bout de `10 min` et l'arrête à `30 min` (mis en pause tant qu'il attend ton accord).
- **Plafond global de tours.** Dans **Réglages → Coordinateur**, **Tours en même temps sur tout le serveur** (défaut `4`, réglable de `1` à `12`) met en file les tours lancés par les coordinateurs, les équipes et les tâches planifiées, sans jamais bloquer tes messages directs (y compris vers le coordinateur) ni compter les tours en attente de permission. Sur un mini-PC de 16 Go de RAM, `2` ou `3` reste le réglage le plus serein.
- **Mises à jour sans écran blanc.** Après `git pull && pnpm install && pnpm build` (puis redémarrage si le serveur a changé), `/api/build` et des `404` propres sur les anciens `/assets/` affichent un bandeau **Recharger** sur les onglets déjà ouverts au lieu de casser la page.
- **Connexion mobile fiable.** Un battement de cœur WebSocket (`20 s` côté client avec délai `8 s`, `30 s` côté serveur) détecte les coupures silencieuses, la reconnexion repart instantanément au réveil de l'écran ou du réseau (`visibilitychange`, `online`, `pageshow`, `focus`), un bandeau **Reconnexion au serveur…** s'affiche en haut de la page et une alerte dans la page signale toute action qui n'a pas pu partir hors-ligne.

## Agents

MoonAgentic a besoin d'au moins un agent installé et connecté sur ta machine.

| Agent           | Connexion initiale     | Intégration                              |
| --------------- | ---------------------- | ---------------------------------------- |
| **Claude Code** | `claude` puis `/login` | Adaptateur ACP inclus                    |
| **Codex**       | `codex login`          | Adaptateur ACP inclus                    |
| **Antigravity** | `agy`                  | ACP natif (`agy acp`)                    |
| **Cursor**      | `agent login`          | ACP natif (`cursor-agent` / `agent acp`) |
| **Hermes**      | `hermes model`         | ACP natif (`hermes acp`)                 |
| **Autre (ACP)** | Selon l'agent          | Ajouté dans **Réglages → Agents**        |

## « Et c'est quoi le piège ? »

Aucun. MoonAgentic est né pour offrir le meilleur poste de pilotage possible sur ses propres agents locaux — sans surcouche payante, sans intermédiaire et sans enfermement.

Tout reste sur ta machine, dans `~/.moonagentic/` (droits réservés à ton utilisateur), avec tes propres comptes et tes propres dépôts :

- `state.sqlite` — base SQLite (WAL) des projets, fils, équipes, Planner, tâches planifiées, réglages et serveurs MCP
- `token` — jeton d'accès local (renouvelable depuis **Réglages → Accès distant**)
- `worktrees/` — worktrees git isolés des fils en cours
- `logs/` — journaux quotidiens rotatifs, jeton masqué (`14` jours)
- `backups/` — sauvegardes SQLite atomiques quotidiennes (`7` jours)

## Contribuer

Les correctifs ciblés et les retours sont les bienvenus. Le dépôt est un monorepo pnpm en trois paquets :

- `packages/protocol` — schémas Zod, types partagés et préréglages d'équipes
- `apps/server` — serveur Node.js en TypeScript natif (`node:http`, `node:sqlite`, `ws`, ACP, superviseur)
- `apps/web` — interface React 19 + Vite 8 (PWA bureau et téléphone)

```bash
pnpm dev        # serveur (--dev + agents de démo) et Vite (http://127.0.0.1:5173)
pnpm test       # suite Vitest
pnpm lint       # Oxlint + Prettier
pnpm typecheck  # vérification TypeScript
pnpm build      # build de production Vite (apps/web/dist)
pnpm e2e        # parcours navigateur (Playwright, après pnpm build)
```

## Licence

[MIT](./LICENSE)
