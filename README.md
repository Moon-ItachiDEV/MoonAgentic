<p align="center">
  <img src="./apps/web/public/icon.svg" width="80" height="80" alt="Logo MoonAgentic" />
</p>

<h1 align="center">MoonAgentic</h1>

<p align="center">Le poste de pilotage open-source pour tes agents de code.</p>

<p align="center">
  <a href="#installation"><strong>Démarrer</strong></a> ·
  <a href="#agents">Agents</a> ·
  <a href="#ce-que-tu-obtiens">Fonctionnalités</a> ·
  <a href="#contribuer">Contribuer</a> ·
  <a href="./LICENSE">MIT</a>
</p>

MoonAgentic pilote les agents de code déjà installés sur ta machine depuis une seule interface rapide. Lance un fil — ou toute une équipe d'agents — au bureau, puis relis les changements et valide la suite depuis ton téléphone.

Il fonctionne avec Claude Code, Codex, Antigravity, Cursor, Hermes et n'importe quel agent compatible ACP. Si un agent est configuré sur ton ordinateur, MoonAgentic peut le piloter.

## Ce que tu obtiens

- **Tes abonnements, ta machine.** MoonAgentic ne revend aucun jeton et ne voit jamais tes identifiants. Il lance directement les agents auxquels tu es déjà connecté.
- **Tous tes agents au même endroit.** Change de modèle en plein fil, passe la main d'un agent à un autre avec relais d'historique, épingle tes favoris et règle le mode ou le raisonnement.
- **Équipes d'agents (`/equipe`).** Un chef découpe la tâche, des codeurs travaillent en parallèle sur leurs branches, relecteur et testeur vérifient chaque part, puis tout est fusionné sur une branche unique avec suivi en direct sur une frise.
- **Git intégré.** Chaque fil peut travailler dans son propre worktree. Revois le diff, reviens à un checkpoint, puis fais un commit, un push et une pull request en un clic.
- **Serveurs MCP centralisés.** Déclare tes serveurs MCP (`stdio` ou HTTP) une seule fois dans **Réglages** : ils sont transmis à tous tes agents, pendant que leurs secrets restent sur ton serveur.
- **Bureau et téléphone.** Un seul serveur local synchronisé en temps réel (PWA iOS et Android) avec une file **À traiter** qui rassemble toutes les demandes d'accord.
- **Composer complet.** Commandes `/`, mentions `@` de fichiers, skills `$`, recherche rapide (`Ctrl K`), jauge de contexte et `/compact`.
- **Ouvert et local.** Sous licence MIT, protégé par jeton local, construit sur Node.js et SQLite sans dépendance lourde. Si quelque chose ne te convient pas, forke-le.

## Installation

Prérequis : **Node.js ≥ 22.18**, **pnpm 10+** et **git** (`gh` en option pour ouvrir les pull requests en un clic).

### Lancer en local

```bash
git clone https://github.com/Moon-ItachiDEV/MoonAgentic.git
cd MoonAgentic
pnpm install
pnpm build
pnpm start
```

Ouvre le lien affiché dans le terminal (`http://127.0.0.1:4747/?token=…`).

### Essayer sans compte ni clé

```bash
node apps/server/src/bin.ts --demo
```

Ajoute deux agents simulés hors-ligne pour tester gratuitement le streaming, les équipes, les diffs, MCP et le passage de relais.

### Accès depuis un téléphone

```bash
node apps/server/src/bin.ts --host 0.0.0.0
```

Ouvre le lien avec jeton sur ton réseau local ou derrière un tunnel chiffré (Tailscale, WireGuard, SSH), puis ajoute la page à l'écran d'accueil en PWA.

## Agents

MoonAgentic a besoin d'au moins un agent installé et connecté sur ta machine.

| Agent           | Connexion initiale     | Intégration              |
| --------------- | ---------------------- | ------------------------ |
| **Claude Code** | `claude` puis `/login` | Adaptateur ACP inclus    |
| **Codex**       | `codex login`          | Adaptateur ACP inclus    |
| **Antigravity** | `agy`                  | ACP natif (`agy acp`)    |
| **Cursor**      | `agent login`          | ACP natif (`agent acp`)  |
| **Hermes**      | `hermes model`         | ACP natif (`hermes acp`) |
| **Autre (ACP)** | Selon l'agent          | Ajouté dans **Réglages** |

## « Et c'est quoi le piège ? »

Aucun. MoonAgentic est né pour offrir le meilleur poste de pilotage possible sur ses propres agents locaux — sans surcouche payante, sans intermédiaire et sans enfermement.

Tout reste sur ta machine, dans `~/.moonagentic`, avec tes propres comptes et tes propres dépôts.

## Contribuer

Les correctifs ciblés et les retours sont les bienvenus.

```bash
pnpm dev        # serveur (--dev + agents de démo) et Vite (http://127.0.0.1:5173)
pnpm test       # suite Vitest
pnpm lint       # Oxlint + Prettier
pnpm typecheck  # vérification TypeScript
pnpm e2e        # parcours navigateur (Playwright, après pnpm build)
```

## Licence

[MIT](./LICENSE)
