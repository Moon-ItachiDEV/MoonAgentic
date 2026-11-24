import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCheck,
  AgentCommand,
  AgentInfo,
  AgentSetting,
  CustomAgentInput,
  FavoriteRef,
  Favorites,
  Mascot,
  McpServerInfo,
  McpServerInput,
  ServerMessage,
} from "@moonagentic/protocol";
import { agentSettingsFor, DEFAULT_MASCOTS, orderedFavorites } from "@moonagentic/protocol";
import type { Agents, CustomAgent } from "./agents.ts";
import { mcpInfo, RESERVED_MCP_NAME, type McpServerRecord } from "./mcp.ts";
import {
  defaultMcpSecretStore,
  extractMcpSecrets,
  hydrateMcpSecrets,
  type McpSecretStore,
  stripMcpSecrets,
} from "./mcp-secrets.ts";
import { AgentSession, describe, type ModelOption, needsSignIn } from "./session.ts";
import type { Store } from "./store.ts";

const DISCOVERY_TIMEOUT_MS = 30_000;

export const agentCommands = (update: acp.AvailableCommandsUpdate): AgentCommand[] =>
  update.availableCommands.slice(0, 200).map((c) => ({
    name: c.name.replace(/^\//, ""),
    description: c.description,
    ...(c.input && "hint" in c.input && c.input.hint ? { hint: c.input.hint } : {}),
  }));

/**
 * What MoonAgentic knows of the agents, apart from any thread: which are installed and
 * signed in, their models, settings and commands, the ones the user added, the MCP servers
 * given to each, and the favorite models.
 */
export class AgentCatalog {
  private readonly discoveries = new Map<string, { done: Promise<void>; stop: AbortController }>();
  /** Why listing an agent's models failed, until a retry succeeds. */
  private readonly discoveryErrors = new Map<string, string>();

  private readonly store: Store;
  private readonly agents: Agents;
  private readonly broadcast: (message: ServerMessage) => void;
  /** Where an agent checked from Connexions, before any project, is started. */
  private readonly homeDir: string;
  /** Where MCP secret values live, kept apart from `state.sqlite` and its backups. */
  private readonly mcpSecrets: McpSecretStore;
  /** Why migrating legacy SQLite MCP secrets failed, if the secret vault rejected writes. */
  private migrationError: string | undefined;
  /** Resolves once MCP secrets are loaded from the vault and any legacy SQLite secrets migrated. */
  readonly ready: Promise<void>;

  constructor(
    store: Store,
    agents: Agents,
    broadcast: (message: ServerMessage) => void,
    homeDir: string,
    mcpSecrets: McpSecretStore = defaultMcpSecretStore(store.file),
  ) {
    this.store = store;
    this.agents = agents;
    this.broadcast = broadcast;
    this.homeDir = homeDir;
    this.mcpSecrets = mcpSecrets;
    this.ready = this.initMcpSecrets();
    agents.setCustom(this.customAgents());
  }

  readonly name = (agentId: string) =>
    this.agents.list().find((a) => a.id === agentId)?.name ?? agentId;

  list(): AgentInfo[] {
    const commands = this.store.getSetting<Record<string, AgentCommand[]>>("agentCommands", {});
    const checks = this.store.getSetting<Record<string, AgentCheck>>("agentChecks", {});
    return this.agents.list().map((base) => {
      const listed = Object.hasOwn(commands, base.id) ? commands[base.id] : undefined;
      const check = Object.hasOwn(checks, base.id) ? checks[base.id] : undefined;
      const allowed = this.mascotAllowed(base.id);
      const mascot = allowed ? this.mascotOf(base.id) : undefined;
      const agent = {
        ...base,
        ...(listed?.length ? { commands: listed } : {}),
        ...(check ? { check } : {}),
        ...(mascot ? { mascot } : {}),
        ...(allowed ? { mascotAllowed: true as const } : {}),
      };
      const known = this.store.getAgentModels(agent.id);
      const modelsError = this.discoveryErrors.get(agent.id);
      if (!known) return modelsError ? { ...agent, modelsError } : agent;
      const defaultModel = this.defaultModel(agent.id);
      return {
        ...agent,
        models: known.models,
        ...(defaultModel ? { defaultModel } : {}),
        // An empty list says the agent has none; a missing one, from an older cache, is unknown.
        ...(known.settings ? { settings: known.settings } : {}),
        ...(known.modelSettings ? { modelSettings: known.modelSettings } : {}),
      };
    });
  }

  private broadcastAgents(): void {
    this.broadcast({ type: "agents", agents: this.list() });
  }

  defaultModel(agentId: string): string | undefined {
    const known = this.store.getAgentModels(agentId);
    if (!known) return undefined;
    const preferred = this.agents.preferredModel(agentId);
    const match =
      preferred && known.models.find((m) => preferred.test(m.name) || preferred.test(m.id));
    return match?.id ?? known.current;
  }

  /** Settings known for `model`, falling back to the agent's general settings when unobserved. */
  settingsFor(agentId: string, model?: string): AgentSetting[] {
    return agentSettingsFor(
      this.store.getAgentModels(agentId),
      model ?? this.defaultModel(agentId),
    );
  }

  /**
   * Remembers the models and settings an agent offers, so new threads can offer them before
   * starting it. Only a fresh session tells the agent's own defaults, or that it offers no
   * model choice, which is remembered too so the UI stops asking.
   */
  learn(
    agentId: string,
    model: ModelOption | undefined,
    settings: AgentSetting[],
    fresh: boolean,
  ): void {
    const before = this.store.getAgentModels(agentId);
    if (!fresh && !model && (!before || !settings.length)) return;
    const keep = !fresh && before;
    const nextModels = model ? model.choices : keep ? before.models : [];
    const nextCurrent = model
      ? keep
        ? before.current
        : model.current
      : keep
        ? before.current
        : "";

    const mergeDefaults = (
      incoming: AgentSetting[],
      ...fallbacks: (AgentSetting[] | undefined)[]
    ): AgentSetting[] =>
      incoming.map((s) => {
        const saved = fallbacks
          .map((list) => list?.find((b) => b.id === s.id)?.current)
          .find((v): v is string => !!v && s.choices.some((c) => c.id === v));
        return { ...s, current: saved ?? s.current };
      });

    const activeModel = model?.current || undefined;
    const validModelIds = new Set(nextModels.map((m) => m.id));
    const nextModelSettings: Record<string, AgentSetting[]> = {};
    if (before?.modelSettings) {
      for (const [id, list] of Object.entries(before.modelSettings)) {
        if (validModelIds.has(id)) nextModelSettings[id] = list;
      }
    }
    if (activeModel && !(keep && !settings.length)) {
      const prevForModel = Object.hasOwn(nextModelSettings, activeModel)
        ? nextModelSettings[activeModel]
        : undefined;
      nextModelSettings[activeModel] = fresh
        ? settings
        : mergeDefaults(settings, prevForModel, before?.settings);
    }

    let nextSettings: AgentSetting[];
    if (keep && !settings.length) {
      // A continued session that leaves its settings out does not take them away.
      nextSettings = before.settings ?? [];
    } else {
      const normalized = keep ? mergeDefaults(settings, before.settings) : settings;
      // Switching to a model without reasoning effort does not wipe effort from models that have it.
      const preserved = (before?.settings ?? []).filter(
        (b) =>
          !normalized.some((s) => s.id === b.id) &&
          Object.entries(nextModelSettings).some(
            ([id, list]) => id !== activeModel && list.some((s) => s.id === b.id),
          ),
      );
      nextSettings = [...normalized, ...preserved];
    }

    const next = {
      models: nextModels,
      current: nextCurrent,
      settings: nextSettings,
      ...(nextModels.length > 0 || Object.keys(nextModelSettings).length > 0
        ? { modelSettings: nextModelSettings }
        : {}),
    };
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    this.store.setAgentModels(agentId, next);
    this.broadcastAgents();
  }

  rememberCommands(agentId: string, commands: AgentCommand[]): void {
    const known = this.store.getSetting<Record<string, AgentCommand[]>>("agentCommands", {});
    if (JSON.stringify(known[agentId] ?? []) === JSON.stringify(commands)) return;
    this.store.setSetting("agentCommands", { ...known, [agentId]: commands });
    this.broadcastAgents();
  }

  /** Remembers whether the agent last started fine, for Connexions. */
  recordCheck(
    agentId: string,
    result: { ok: true; version: string | undefined } | { ok: false; error: unknown },
    /** A check the user asked for is always recorded, so its time moves on. */
    asked = false,
  ): void {
    const check: AgentCheck = result.ok
      ? { at: Date.now(), ok: true, ...(result.version ? { version: result.version } : {}) }
      : {
          at: Date.now(),
          ok: false,
          error: describe(result.error),
          ...(needsSignIn(result.error) ? { signInNeeded: true } : {}),
        };
    const checks = this.store.getSetting<Record<string, AgentCheck>>("agentChecks", {});
    const before = checks[agentId];
    // A thread starting again and again only tells something when the answer changes.
    if (!asked && before?.ok && check.ok && before.version === check.version) return;
    this.store.setSetting("agentChecks", { ...checks, [agentId]: check });
    this.broadcastAgents();
  }

  /**
   * Starts the agent briefly so the UI can list its models before the first message.
   * A failure is shown with the agent (`modelsError`) rather than thrown, so the picker can offer a retry.
   */
  discover(agentId: string, cwd?: string): Promise<void> {
    const running = this.discoveries.get(agentId);
    if (running) return running.done;
    if (this.discoveryErrors.delete(agentId)) this.broadcastAgents();
    let launch;
    try {
      launch = this.agents.launch(agentId);
    } catch (error) {
      // Gone from this machine since the list was sent: said with the agent, like a failure.
      this.discoveryErrors.set(agentId, describe(error));
      this.recordCheck(agentId, { ok: false, error }, true);
      return Promise.resolve();
    }
    const stop = new AbortController();
    const done = AgentSession.start({
      launch,
      // Checked from Connexions, before any project: the home folder will do.
      cwd: cwd ?? this.homeDir,
      previousSessionId: null,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
      handlers: {
        // Its commands too, so a new thread can offer them before its agent starts.
        onUpdate: (update) => {
          if (update.sessionUpdate === "available_commands_update") {
            this.rememberCommands(agentId, agentCommands(update));
          }
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExit: () => undefined,
      },
    })
      .then(
        async (session) => {
          try {
            this.recordCheck(agentId, { ok: true, version: session.agentVersion }, true);
            this.learn(agentId, session.model, session.settings, session.fresh);
            const wanted = this.defaultModel(agentId);
            if (
              !stop.signal.aborted &&
              wanted &&
              session.model &&
              wanted !== session.model.current &&
              session.model.choices.some((c) => c.id === wanted)
            ) {
              try {
                await session.setModel(wanted);
                this.learn(agentId, session.model, session.settings, false);
              } catch {
                // Switching during discovery is best effort; keep what the initial model reported.
              }
            }
          } finally {
            await session.close();
          }
        },
        (error: unknown) => {
          if (stop.signal.aborted) return;
          this.discoveryErrors.set(agentId, describe(error));
          this.recordCheck(agentId, { ok: false, error }, true);
        },
      )
      .finally(() => this.discoveries.delete(agentId));
    this.discoveries.set(agentId, { done, stop });
    return done;
  }

  /** Adds an ACP agent of the user's own, started by `command` with `args`. */
  addCustomAgent(input: CustomAgentInput): string {
    const name = input.name.trim();
    if (this.agents.list().some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Un agent s'appelle déjà « ${name} ».`);
    }
    const id = `custom-${randomUUID().slice(0, 8)}`;
    this.saveCustomAgents([
      ...this.customAgents(),
      { id, name, command: input.command.trim(), args: input.args },
    ]);
    return id;
  }

  /** Removes an agent the user added; its threads can then be handed to another agent. */
  removeCustomAgent(agentId: string): void {
    const agents = this.customAgents();
    if (!agents.some((a) => a.id === agentId))
      throw new Error("Cet agent n'a pas été ajouté par toi.");
    this.discoveries.get(agentId)?.stop.abort();
    this.discoveryErrors.delete(agentId);
    this.saveCustomAgents(agents.filter((a) => a.id !== agentId));
  }

  private customAgents(): CustomAgent[] {
    return this.store.getSetting<CustomAgent[]>("customAgents", []);
  }

  private saveCustomAgents(agents: CustomAgent[]): void {
    this.store.setSetting("customAgents", agents);
    this.agents.setCustom(agents);
    this.broadcastAgents();
  }

  /** The agent's moon: the one the user picked, none if they chose none, else its default. */
  private mascotOf(agentId: string): Mascot | undefined {
    const picked = this.store.getSetting<Record<string, Mascot | null>>("mascots", {});
    if (Object.hasOwn(picked, agentId)) return picked[agentId] ?? undefined;
    return Object.hasOwn(DEFAULT_MASCOTS, agentId) ? DEFAULT_MASCOTS[agentId] : undefined;
  }

  /**
   * Only Hermes has a moon, and the Hermes bots the user added (an agent of their own whose
   * command is `hermes`, a profile for instance): the other agents keep their logo.
   */
  private mascotAllowed(agentId: string): boolean {
    if (agentId === "hermes") return true;
    const custom = this.customAgents().find((a) => a.id === agentId);
    return (
      !!custom &&
      /^hermes(?:\.(?:exe|cmd|bat|ps1))?$/i.test(custom.command.trim().split(/[\\/]/).pop() ?? "")
    );
  }

  /** Gives the agent its moon, or none (`null`), on every device. */
  setMascot(agentId: string, mascot: Mascot | null): void {
    if (!this.agents.list().some((a) => a.id === agentId))
      throw new Error(`Agent inconnu : ${agentId}`);
    if (!this.mascotAllowed(agentId))
      throw new Error("Seuls Hermes et tes bots Hermes ont une mascotte.");
    const picked = this.store.getSetting<Record<string, Mascot | null>>("mascots", {});
    this.store.setSetting("mascots", { ...picked, [agentId]: mascot });
    this.broadcastAgents();
  }

  favorites(): Favorites {
    return this.store.getSetting<Favorites>("favorites", {});
  }

  toggleFavorite(agentId: string, model: string, starred: boolean): void {
    if (!this.agents.list().some((a) => a.id === agentId))
      throw new Error(`Agent inconnu : ${agentId}`);
    const favorites = this.favorites();
    const current = Object.hasOwn(favorites, agentId) ? (favorites[agentId] ?? []) : [];
    const next = current.filter((m) => m !== model);
    favorites[agentId] = starred ? [...next, model] : next;
    this.store.setSetting("favorites", favorites);
    // A new favorite joins the end of the wheel; one taken out leaves the order.
    const order = this.favoriteOrder().filter((r) => r.agentId !== agentId || r.model !== model);
    this.store.setSetting(
      "favoriteOrder",
      orderedFavorites(favorites, starred ? [...order, { agentId, model }] : order),
    );
    this.broadcastFavorites();
  }

  /** The favorites in the user's order, every one of them once. */
  favoriteOrder(): FavoriteRef[] {
    return orderedFavorites(
      this.favorites(),
      this.store.getSetting<FavoriteRef[]>("favoriteOrder", []),
    );
  }

  /** Puts the favorites in this order; favorites it leaves out keep their place after it. */
  reorderFavorites(order: FavoriteRef[]): void {
    this.store.setSetting("favoriteOrder", orderedFavorites(this.favorites(), order));
    this.broadcastFavorites();
  }

  private broadcastFavorites(): void {
    this.broadcast({
      type: "favorites",
      favorites: this.favorites(),
      order: this.favoriteOrder(),
    });
  }

  private rawMcpServers(): McpServerRecord[] {
    return this.store.getSetting<McpServerRecord[]>("mcpServers", []);
  }

  /**
   * Loads MCP secrets asynchronously and migrates any plaintext values stored in `state.sqlite`
   * by an earlier version. Never throws: decryption failures stay recorded in `mcpSecretsError()`
   * so clients still connect and Connexions can report them.
   */
  private async initMcpSecrets(): Promise<void> {
    await this.mcpSecrets.load();
    const raw = this.rawMcpServers();
    const hasPlaintext = raw.some((s) => Object.keys(extractMcpSecrets(s)).length > 0);
    if (hasPlaintext && !this.mcpSecrets.error()) {
      try {
        const stripped: McpServerRecord[] = [];
        for (const server of raw) {
          const secrets = extractMcpSecrets(server);
          if (Object.keys(secrets).length === 0) {
            stripped.push(server);
            continue;
          }
          await this.mcpSecrets.set(server.id, { ...this.mcpSecrets.get(server.id), ...secrets });
          stripped.push(stripMcpSecrets(server));
        }
        this.store.setSetting("mcpServers", stripped);
        this.migrationError = undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.migrationError = `Impossible de migrer les secrets MCP hors de la base : ${detail}`;
        console.error("Migration des secrets MCP impossible :", error);
      }
    }
    const err = this.mcpSecretsError();
    if (err) {
      this.broadcast({ type: "mcpServers", servers: this.mcpServerInfos(), error: err });
    }
  }

  /** Public server metadata (secret names only, never touches the secret vault). */
  mcpServerInfos(): McpServerInfo[] {
    return this.rawMcpServers().map(mcpInfo);
  }

  /** Why MCP secrets could not be decrypted/migrated, if a vault error happened. */
  mcpSecretsError(): string | undefined {
    return this.mcpSecrets.error() ?? this.migrationError;
  }

  /** Enabled/disabled servers with their decrypted secret values, ready to pass to an agent. */
  async mcpServers(): Promise<McpServerRecord[]> {
    await this.ready;
    return this.rawMcpServers().map((s) => hydrateMcpSecrets(s, this.mcpSecrets.get(s.id)));
  }

  /** Registers an MCP server for the agent sessions started from now on. */
  async addMcpServer(input: McpServerInput): Promise<string> {
    const key = input.name.trim().toLowerCase();
    if (key === RESERVED_MCP_NAME) {
      throw new Error(`Le nom « ${RESERVED_MCP_NAME} » est réservé à MoonAgentic.`);
    }
    await this.ready;
    if (this.rawMcpServers().some((s) => s.name.trim().toLowerCase() === key)) {
      throw new Error(`Un serveur MCP s'appelle déjà « ${input.name} ».`);
    }
    const id = randomUUID();
    const { projectIds, allRoles, ...server } = input;
    const record: McpServerRecord = {
      ...server,
      id,
      enabled: true,
      ...(projectIds ? { projectIds: this.knownProjects(projectIds) } : {}),
      ...(allRoles ? { allRoles: true } : {}),
    };
    const secrets = extractMcpSecrets(record);
    if (Object.keys(secrets).length) await this.mcpSecrets.set(id, secrets);
    this.updateMcpServers((servers) => [...servers, stripMcpSecrets(record)]);
    return id;
  }

  setMcpEnabled(id: string, enabled: boolean): void {
    if (!this.rawMcpServers().some((s) => s.id === id)) return;
    this.updateMcpServers((servers) => servers.map((s) => (s.id === id ? { ...s, enabled } : s)));
  }

  /** Says which projects get the server (`null` for every project), and which roles. */
  setMcpScope(id: string, projectIds: string[] | null, allRoles: boolean): void {
    if (!this.rawMcpServers().some((s) => s.id === id)) return;
    this.updateMcpServers((servers) =>
      servers.map((s) => {
        if (s.id !== id) return s;
        const { projectIds: _projects, allRoles: _roles, ...rest } = s;
        return {
          ...rest,
          ...(projectIds ? { projectIds: this.knownProjects(projectIds) } : {}),
          ...(allRoles ? { allRoles: true } : {}),
        };
      }),
    );
  }

  /**
   * A project is gone: the servers that were for it are no longer. One that was for it
   * alone is left for no project, never widened to all of them.
   */
  projectRemoved(projectId: string): void {
    if (!this.rawMcpServers().some((s) => s.projectIds?.includes(projectId))) return;
    this.updateMcpServers((servers) =>
      servers.map((s) =>
        s.projectIds ? { ...s, projectIds: s.projectIds.filter((p) => p !== projectId) } : s,
      ),
    );
  }

  private knownProjects(projectIds: string[]): string[] {
    return [...new Set(projectIds)].filter((id) => this.store.getProject(id));
  }

  async removeMcpServer(id: string): Promise<void> {
    if (!this.rawMcpServers().some((s) => s.id === id)) return;
    await this.ready;
    this.updateMcpServers((servers) => servers.filter((s) => s.id !== id));
    const empty = this.rawMcpServers().length === 0;
    const cleanup = empty ? this.mcpSecrets.clear() : this.mcpSecrets.delete(id);
    await cleanup.catch((error: unknown) => {
      console.error("Suppression du secret MCP impossible :", error);
    });
    if (empty && !this.mcpSecrets.error()) this.migrationError = undefined;
    const err = this.mcpSecretsError();
    if (!err) this.broadcast({ type: "mcpServers", servers: this.mcpServerInfos() });
  }

  private updateMcpServers(change: (servers: McpServerRecord[]) => McpServerRecord[]): void {
    const servers = change(this.rawMcpServers());
    this.store.setSetting("mcpServers", servers);
    const err = this.mcpSecretsError();
    this.broadcast({
      type: "mcpServers",
      servers: servers.map(mcpInfo),
      ...(err ? { error: err } : {}),
    });
  }

  /** Stops the agents started only to be checked, and resolves once they are gone. */
  async close(): Promise<void> {
    const discoveries = [...this.discoveries.values()];
    for (const d of discoveries) d.stop.abort();
    await Promise.all([
      this.ready.catch(() => undefined),
      ...discoveries.map((d) => d.done.catch(() => undefined)),
    ]);
  }
}
