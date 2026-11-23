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

`pnpm start` relance le serveur tout seul s'il plante (après 1 s, puis de plus en plus tard si les plantages se suivent, jusqu'à 1 min). Ce qu'il affiche est aussi écrit, jeton masqué, dans `~/.moonagentic/logs/` (un fichier par jour, 14 jours gardés), et une copie de la base est faite chaque jour dans `~/.moonagentic/backups/` (7 jours gardés). Pour revenir à une copie, arrête MoonAgentic et remplace `~/.moonagentic/state.sqlite` par elle (en supprimant `state.sqlite-wal` et `state.sqlite-shm` à côté).

### Essayer sans compte ni clé

```bash
node apps/server/src/bin.ts --demo
```

Ajoute deux agents simulés hors-ligne pour tester gratuitement le streaming, les équipes, les diffs, MCP et le passage de relais.

### Accès depuis un téléphone

**Réglages → Accès distant** affiche l'adresse à ouvrir depuis un autre appareil, le lien avec jeton et son QR code à scanner. La page détecte Tailscale toute seule ; sans lui, elle donne l'adresse du réseau local si tu as lancé le serveur avec `--host 0.0.0.0` :

```bash
node apps/server/src/bin.ts --host 0.0.0.0
```

Sans Tailscale, le trafic n'est pas chiffré : reste sur un réseau de confiance. Si le lien a pu fuiter, **Renouveler le jeton** coupe aussitôt l'ancien.

### Faire tourner 24h/24 sur un mini-PC Windows 11 + Tailscale

Le mini-PC garde tes agents en marche ; ton PC principal et ton téléphone s'y connectent en HTTPS par [Tailscale](https://tailscale.com/download), sans ouvrir de port sur ta box.

1. **Sur le mini-PC**, installe Node.js, pnpm, git, tes agents (connectés une fois à la main) et MoonAgentic comme ci-dessus. Installe Tailscale et connecte-toi ; fais de même sur ton PC principal et ton téléphone, avec le même compte.
2. **Lance MoonAgentic** (`pnpm start`). Il reste sur `127.0.0.1` : inutile d'ajouter `--host`.
3. **Publie-le sur ton réseau Tailscale**, une fois pour toutes, dans un terminal du mini-PC :

   ```powershell
   tailscale serve --bg 4747
   ```

   Si `tailscale` n'est pas reconnu, utilise `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 4747`. La première fois, Tailscale peut te demander d'activer HTTPS pour ton réseau : suis le lien qu'il affiche.

4. **Ouvre Réglages → Accès distant** sur le mini-PC : l'adresse `https://<mini-pc>.<ton-réseau>.ts.net` y apparaît avec son QR code. Scanne-le avec ton téléphone, copie le lien sur ton PC principal, puis ajoute la page à l'écran d'accueil.
5. **Pour qu'il tourne sans toi** : dans Windows, _Paramètres → Système → Alimentation_, mets la mise en veille sur « Jamais ». Pour relancer MoonAgentic à chaque ouverture de session, fais `Win + R`, tape `shell:startup`, et crée dans ce dossier un fichier `MoonAgentic.cmd` (remplace le chemin par celui de ton clone) :

   ```bat
   @echo off
   cd /d "C:\chemin\vers\MoonAgentic"
   pnpm start
   ```

   Pas besoin de droits administrateur. Évite une tâche planifiée `schtasks` : Windows arrête par défaut une tâche qui tourne depuis plus de 3 jours. Tailscale, lui, redémarre tout seul avec Windows et se souvient de `serve --bg`.

Pour être prévenu quand un fil attend ta réponse ou qu'une équipe a fini, active **Réglages → Général → Notifications** sur chaque appareil. Le navigateur ne les autorise qu'en HTTPS, ce que donne `tailscale serve`, et tant que MoonAgentic reste ouvert dans un onglet.

N'utilise pas `tailscale funnel` : il ouvrirait MoonAgentic à tout Internet. Réglages → Accès distant te prévient si c'est le cas.

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
