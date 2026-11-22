# MoonAgentic

MoonAgentic est un environnement de développement agentique (ADE) : une seule interface, sur ordinateur comme sur téléphone, pour piloter les agents de code déjà installés sur ta machine (Claude Code, Antigravity, Hermes, Codex, Cursor…) et les serveurs MCP.

Le projet repart de zéro avec son propre code. Les agents sont branchés via le protocole commun ACP (Agent Client Protocol) : un seul client dans le serveur MoonAgentic, et chaque agent parle le même langage.

## État

En construction. Jalon 1 : sidebar et composer, conversation en direct avec Claude Code et Antigravity (messages, outils, permissions), historique sauvegardé. Jalon 2 : Codex et Cursor, choix du modèle de chaque agent (avant et pendant un fil) et modèles favoris. Ensuite : serveurs MCP, branche à part par fil avec revue et envoi, mode et raisonnement de l'agent, jauge de contexte.

## Lancer MoonAgentic

Il faut Node 22.18 ou plus récent et pnpm.

```sh
pnpm install
pnpm build   # construit l'interface web
pnpm start   # démarre le serveur, puis ouvre le lien affiché (il contient ton jeton)
```

Le serveur écoute sur `127.0.0.1:4747` et garde ses données dans `~/.moonagentic`. Pour l'ouvrir depuis ton téléphone sur le même réseau : `node apps/server/src/bin.ts --host 0.0.0.0`, puis ouvre le lien avec l'adresse de ton ordinateur.

Agents reconnus : Claude Code et Codex (inclus), Antigravity (`agy`), Cursor (`agent`) et Hermes (`hermes`) s'ils sont installés.

Connexion aux agents : connecte-toi une fois avec ton propre compte dans l'outil officiel de chaque agent (`claude` puis `/login`, `codex login`, `agent login`, `agy`), ou fournis ta propre clé API. MoonAgentic lance ces outils tels quels sur ta machine et ne voit, ne stocke ni ne relaie jamais tes identifiants.

Serveurs MCP : ajoute-les une fois dans « Serveurs MCP » (une commande ou une adresse, avec leurs secrets). Chaque agent les reçoit au démarrage d'un fil. Les secrets restent dans `~/.moonagentic` et ne sont jamais envoyés à l'interface.

Branche à part : dans un projet git, chaque fil peut travailler sur sa propre branche, dans une copie du projet gardée dans `~/.moonagentic/worktrees`. Le bouton « À revoir » montre ce qui a changé, puis commit et push, avec ouverture de la PR par ton propre `gh` s'il est installé et connecté.

Mode, raisonnement et contexte : quand l'agent les propose, son mode (plan, agent…) et son niveau de raisonnement se choisissent dans le menu de l'agent, avant ou pendant un fil. Une jauge à côté du bouton d'envoi montre la place prise dans le contexte de l'agent, avec « Compacter la conversation » si l'agent sait le faire.

`node apps/server/src/bin.ts --demo` ajoute un agent de démo gratuit pour essayer l'interface.

## Développer

```sh
pnpm dev        # serveur + interface avec rechargement, lien sur le port 5173
pnpm test       # tests
pnpm lint && pnpm typecheck
```

- `packages/protocol` : les messages échangés entre l'interface et le serveur.
- `apps/server` : le serveur Node (agents ACP, SQLite, WebSocket).
- `apps/web` : l'interface React.

## Licence

MIT, voir [LICENSE](LICENSE).
