// What opens from the composer's « + »: the menu above it, the « Ajouter » sheet with the rest,
// and where a new conversation is held.
import type { McpServerInfo, PermissionMode, Project } from "@moonagentic/protocol";
import { isDiscussionsProject } from "../default-models.ts";
import { mcpInProject } from "../mcp-scope.ts";
import { useEffect, useRef, useState } from "react";
import { Dropdown } from "../v2/Dropdown.tsx";
import { I } from "../v2/I.tsx";
import { Sheet } from "../v2/Sheet.tsx";
import { useScreen } from "../v2/use-screen.ts";
import { arrowKeys } from "../composer-tray.ts";
import { ProjectIcon } from "./ProjectIcon.tsx";

/** A screen that is touched, so most likely a phone or a tablet with a camera. */
const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** What the composer is given to work with, shared by the menu and the sheet. */
export interface ComposerContext {
  project: Project | undefined;
  /** The projects a new conversation can start in; absent in a thread, whose project is set. */
  projects?: Project[];
  /** A thread's own branch, once it has one. */
  branch?: string;
  mcpServers: McpServerInfo[];
}

const codeProjectOf = (project: Project | undefined) =>
  project && !isDiscussionsProject(project) ? project : undefined;
const serversOf = (c: ComposerContext) =>
  c.mcpServers.filter((s) => s.enabled && mcpInProject(s, c.project?.id));

/** The « + » menu, above the composer. */
export function PlusPop(
  props: ComposerContext & {
    /** Closing, it shrinks back into its button. */
    out: boolean;
    onImage: (from: "files" | "camera") => void;
    /** Starts the word the composer completes: @ files, $ skills, / commands. */
    onInsert: (word: "@" | "$" | "/") => void;
    onWhere: () => void;
    /** On an iPad or a computer, where to work opens beside the menu, as a menu of its own. */
    where?: WhereChoices;
    onMcp: () => void;
    onMore: () => void;
  },
) {
  const code = codeProjectOf(props.project);
  const { roomy } = useScreen();
  const whereRow = useRef<HTMLButtonElement>(null);
  const [whereOpen, setWhereOpen] = useState(false);
  const beside = roomy && !!props.where;
  // The menu folding away takes its « Projet » menu with it at once, and opens closed again.
  useEffect(() => {
    if (props.out) setWhereOpen(false);
  }, [props.out]);
  const servers = serversOf(props).length;
  let i = 0;
  const at = () => ({ "--i": i++ }) as React.CSSProperties;
  return (
    <div
      className={`pmenu${props.out ? " out" : ""}`}
      role="menu"
      aria-label="Ajouter"
      aria-hidden={props.out || undefined}
      onKeyDown={arrowKeys}
    >
      {touch && (
        <button
          className="pi2"
          role="menuitem"
          style={at()}
          onClick={() => props.onImage("camera")}
        >
          <I n="camera" s={20} />
          <span className="nm">Caméra</span>
        </button>
      )}
      <button className="pi2" role="menuitem" style={at()} onClick={() => props.onImage("files")}>
        <I n="image" s={20} />
        <span className="nm">Photos</span>
      </button>
      <button className="pi2" role="menuitem" style={at()} onClick={() => props.onInsert("@")}>
        <I n="file" s={20} />
        <span className="nm">Fichiers</span>
      </button>
      {props.projects ? (
        <button
          ref={whereRow}
          className="pi2"
          role="menuitem"
          aria-haspopup={beside ? "menu" : "dialog"}
          style={at()}
          onClick={beside ? () => setWhereOpen((on) => !on) : props.onWhere}
        >
          <I n="folder" s={20} />
          <span className="nm">Projet</span>
          <span className="rt">{code ? code.name : "Aucun"}</span>
        </button>
      ) : (
        props.branch && (
          <div className="pi2 ro" style={at()}>
            <I n="branch" s={20} />
            <span className="nm">Branche</span>
            <span className="rt mono">{props.branch}</span>
          </div>
        )
      )}
      <div className="psep" style={at()} />
      <button className="pi2" role="menuitem" style={at()} onClick={props.onMcp}>
        <I n="plug" s={20} />
        <span className="nm">Serveurs MCP</span>
        {servers > 0 && <span className="rt">{servers}</span>}
      </button>
      <button className="pi2" role="menuitem" style={at()} onClick={() => props.onInsert("$")}>
        <span className="pk">$</span>
        <span className="nm">Skills</span>
      </button>
      <button className="pi2" role="menuitem" style={at()} onClick={() => props.onInsert("/")}>
        <span className="pk">/</span>
        <span className="nm">Commandes</span>
      </button>
      <button className="pi2" role="menuitem" style={at()} onClick={props.onMore}>
        <I n="dots" s={20} />
        <span className="nm">Plus</span>
      </button>
      {beside && whereOpen && !props.out && props.where && (
        <Dropdown anchor={whereRow} side onClose={() => setWhereOpen(false)} label="Où travailler">
          <WhereItems {...props.where} project={props.project} />
        </Dropdown>
      )}
    </div>
  );
}

/** Where a new conversation can be held: outside any project, or in one of them. */
export interface WhereChoices {
  projects: Project[];
  onPickProject: (id: string) => void;
  onPickLoose?: () => void;
  onNewProject: () => void;
}

/** The same choices as the « Où travailler » sheet, as the lines of a menu. */
function WhereItems(props: WhereChoices & { project: Project | undefined }) {
  const code = codeProjectOf(props.project);
  const projects = props.projects.filter((p) => !isDiscussionsProject(p));
  return (
    <>
      {props.onPickLoose && (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!code}
            onClick={props.onPickLoose}
          >
            <span className="ddi">
              <I n="bubble" s={16} />
            </span>
            <span className="ddt">Hors projet</span>
            {!code && (
              <span className="ddk">
                <I n="check" s={15} />
              </span>
            )}
          </button>
          <hr />
        </>
      )}
      {projects.length > 0 && <div className="ddh">Projets</div>}
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          role="menuitemradio"
          aria-checked={p.id === code?.id}
          onClick={() => props.onPickProject(p.id)}
        >
          <span className="ddi">
            <ProjectIcon project={p} size={16} />
          </span>
          <span className="ddt">{p.name}</span>
          {p.id === code?.id && (
            <span className="ddk">
              <I n="check" s={15} />
            </span>
          )}
        </button>
      ))}
      <hr />
      <button type="button" role="menuitem" onClick={props.onNewProject}>
        <span className="ddi">
          <I n="plus" s={16} />
        </span>
        <span className="ddt">Nouveau projet</span>
      </button>
    </>
  );
}

/** « Ajouter » : everything the « + » offers, with the access mode and where the agent works. */
export function PlusSheet(
  props: ComposerContext & {
    open: boolean;
    onClose: () => void;
    mode: PermissionMode;
    onMode: (mode: PermissionMode) => void;
    /** A new conversation in a git project: whether the agent gets its own branch. */
    isolated?: { on: boolean; onPick: (on: boolean) => void };
    onImage: (from: "files" | "camera") => void;
    onInsert: (word: "@" | "$" | "/") => void;
    onWhere: () => void;
    onMcp: () => void;
  },
) {
  const code = codeProjectOf(props.project);
  const servers = serversOf(props).length;
  const then = (run: () => void) => () => {
    props.onClose();
    run();
  };
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Ajouter">
      <div className="sbody">
        <div className="tiles">
          <button className="tile press" onClick={then(() => props.onImage("camera"))}>
            <I n="camera" s={24} />
            Photo
          </button>
          <button className="tile press" onClick={then(() => props.onImage("files"))}>
            <I n="image" s={24} />
            Image
          </button>
          <button className="tile press" onClick={then(() => props.onInsert("@"))}>
            <I n="file" s={24} />
            Fichier
          </button>
        </div>
        <div className="ins">
          <button className="it" onClick={then(() => props.onInsert("$"))}>
            <span className="ic">
              <span className="key">$</span>
            </span>
            <span className="tx">Utiliser un skill</span>
            <I n="right" s={15} />
          </button>
          <button className="it" onClick={then(() => props.onInsert("/"))}>
            <span className="ic">
              <span className="key">/</span>
            </span>
            <span className="tx">Lancer une commande</span>
            <I n="right" s={15} />
          </button>
        </div>
        <div className="gl2">Accès</div>
        <div className="seg three" role="radiogroup" aria-label="Mode d'accès">
          <button
            role="radio"
            aria-checked={props.mode === "supervised"}
            aria-pressed={props.mode === "supervised"}
            onClick={() => props.onMode("supervised")}
          >
            <I n="hand" s={15} />
            Demande d'abord
          </button>
          <button
            role="radio"
            aria-checked={props.mode === "edits"}
            aria-pressed={props.mode === "edits"}
            title="Modifie les fichiers du fil sans demander ; les commandes demandent encore"
            onClick={() => props.onMode("edits")}
          >
            <I n="edit" s={15} />
            Éditions auto
          </button>
          <button
            className="f"
            role="radio"
            aria-checked={props.mode === "full"}
            aria-pressed={props.mode === "full"}
            onClick={() => props.onMode("full")}
          >
            <I n="bolt" s={15} />
            Accès complet
          </button>
        </div>
        {props.isolated && (
          <>
            <div className="gl2">L'agent travaille</div>
            <div className="seg" role="radiogroup" aria-label="Branche">
              <button
                role="radio"
                aria-checked={props.isolated.on}
                aria-pressed={props.isolated.on}
                onClick={() => props.isolated?.onPick(true)}
              >
                <I n="branch" s={16} />
                Sur une branche à part
              </button>
              <button
                role="radio"
                aria-checked={!props.isolated.on}
                aria-pressed={!props.isolated.on}
                onClick={() => props.isolated?.onPick(false)}
              >
                <I n="folder" s={16} />
                Dans ton dossier
              </button>
            </div>
          </>
        )}
        <div className="gl2">Où</div>
        <div className="ins">
          {props.projects ? (
            <button className="it" onClick={then(props.onWhere)}>
              <span className="ic">
                {code ? <ProjectIcon project={code} size={18} /> : <I n="bubble" s={18} />}
              </span>
              <span className="tx">{code ? code.name : "Hors projet"}</span>
              <span className="rt">
                Changer
                <I n="right" s={15} />
              </span>
            </button>
          ) : (
            code && (
              <div className="it ro">
                <span className="ic">
                  <ProjectIcon project={code} size={18} />
                </span>
                <span className="tx">{code.name}</span>
                {props.branch && (
                  <span className="rt">
                    <span className="mono">{props.branch}</span>
                  </span>
                )}
              </div>
            )
          )}
          <button className="it" onClick={then(props.onMcp)}>
            <span className="ic">
              <I n="plug" s={18} />
            </span>
            <span className="tx">Serveurs MCP</span>
            <span className="rt">
              {servers > 0 ? `${servers} ${servers > 1 ? "actifs" : "actif"}` : "Aucun"}
              <I n="right" s={15} />
            </span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** « Où travailler » : outside any project, or in one of them. */
export function WhereSheet(props: {
  open: boolean;
  onClose: () => void;
  project: Project | undefined;
  projects: Project[];
  onPickProject: (id: string) => void;
  onPickLoose?: () => void;
  onNewProject: () => void;
}) {
  const code = codeProjectOf(props.project);
  const then = (run: () => void) => () => {
    props.onClose();
    run();
  };
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Où travailler">
      <div className="sbody">
        {props.onPickLoose && (
          <div className="ins">
            <button className="it" onClick={then(props.onPickLoose)}>
              <span className="ic">
                <I n="bubble" s={18} />
              </span>
              <span className="tx">
                Hors projet
                <small>Questions et recherche web</small>
              </span>
              {!code && <I n="check" s={20} className="ck" />}
            </button>
          </div>
        )}
        <div className="gl2">Projets</div>
        <div className="ins">
          {props.projects
            .filter((p) => !isDiscussionsProject(p))
            .map((p) => (
              <button key={p.id} className="it" onClick={then(() => props.onPickProject(p.id))}>
                <span className="ic">
                  <ProjectIcon project={p} size={18} />
                </span>
                <span className="tx">{p.name}</span>
                {p.id === code?.id && <I n="check" s={20} className="ck" />}
              </button>
            ))}
          <button className="it" onClick={then(props.onNewProject)}>
            <span className="ic">
              <I n="plus" s={18} />
            </span>
            <span className="tx">Nouveau projet</span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}
