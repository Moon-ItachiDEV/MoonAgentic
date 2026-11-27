import type { Project } from "@moonagentic/protocol";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { connection } from "../connection.ts";
import { isDiscussionsProject } from "../default-models.ts";
import { notificationsOn, projectMuted, setProjectMuted } from "../notifications.ts";
import { syncPush } from "../push.ts";
import { Dropdown } from "../v2/Dropdown.tsx";
import { I } from "../v2/I.tsx";
import type { IconName } from "../v2/sprite.ts";
import { useExit } from "../v2/use-exit.ts";
import { useMouse, useScreen } from "../v2/use-screen.ts";

type Line = {
  label: string;
  icon: IconName;
  run: () => void;
  /** The value it has now, on its right (« Activées »). */
  value?: string;
  /** Opens a choice of its own rather than acting. */
  more?: boolean;
  danger?: boolean;
};

/**
 * The project's menu, dropped from its name in the header: what can be done with the project
 * itself. Its notifications open beside it (iPad, computer) or in its place (phone).
 */
export function ProjectMenu(props: {
  project: Project;
  open: boolean;
  anchor: React.RefObject<HTMLElement | null>;
  /** Something of the project is not read yet. */
  unread: boolean;
  onClose: () => void;
  onRename: () => void;
  onSettings: () => void;
  onLock: () => void;
  onRemove: () => void;
}) {
  const { project, onClose } = props;
  const { roomy } = useScreen();
  const desk = useMouse();
  const shown = useExit(props.open);
  const [page, setPage] = useState<"main" | "notif">("main");
  const [side, setSide] = useState(false);
  /** Came back from a page of its own: the lines slide in from the left. */
  const [stepped, setStepped] = useState(false);
  // Read at each look: another window of this device may have changed it.
  const muted = projectMuted(project.id);
  const [, mutedAgain] = useState(0);
  const notifRow = useRef<HTMLButtonElement>(null);
  const side2 = useExit(side && props.open);
  // Back to its first page once gone, not while it leaves: it goes as it was.
  if (!shown.mounted && (page !== "main" || side || stepped)) {
    setPage("main");
    setSide(false);
    setStepped(false);
  }
  if (!shown.mounted) return null;

  const close = (run: () => void) => () => {
    onClose();
    run();
  };
  const mute = (on: boolean) => {
    setProjectMuted(project.id, on);
    mutedAgain((n) => n + 1);
    // The server, which sends Web Push, must know it too.
    syncPush();
  };
  const groups = (
    [
      desk && roomy
        ? [
            {
              label: "Ouvrir dans une nouvelle fenêtre",
              icon: "ext",
              run: close(() => window.open(location.href, "_blank", "noopener")),
            },
          ]
        : [],
      [
        {
          label: project.pinned ? "Désépingler" : "Épingler",
          icon: "star",
          run: close(() =>
            connection.send({
              type: "project.setPinned",
              projectId: project.id,
              pinned: !project.pinned,
            }),
          ),
        },
        ...(props.unread
          ? [
              {
                label: "Tout marquer comme lu",
                icon: "dot" as const,
                run: close(() =>
                  connection.send({ type: "project.markRead", projectId: project.id }),
                ),
              },
            ]
          : []),
        { label: "Renommer", icon: "edit", run: close(props.onRename) },
        // Only where this device notifies at all: nothing to cut otherwise.
        ...(notificationsOn()
          ? [
              {
                label: "Notifications",
                icon: "bell" as const,
                value: muted ? "Coupées" : "Activées",
                more: true,
                run: () => (roomy ? setSide((on) => !on) : setPage("notif")),
              },
            ]
          : []),
      ],
      [
        { label: "Paramètres du projet", icon: "gear", run: close(props.onSettings) },
        { label: "Verrouiller par code", icon: "lock", run: close(props.onLock) },
      ],
      [
        ...(isDiscussionsProject(project)
          ? []
          : [
              {
                label: project.archived ? "Sortir des archives" : "Archiver",
                icon: "archive" as const,
                run: close(() =>
                  connection.send({
                    type: "project.setArchived",
                    projectId: project.id,
                    archived: !project.archived,
                  }),
                ),
              },
            ]),
        { label: "Retirer de MoonAgentic", icon: "x", danger: true, run: close(props.onRemove) },
      ],
    ] as Line[][]
  ).filter((g) => g.length);

  const choice = (label: string, on: boolean, run: () => void): ReactNode => (
    <button key={label} type="button" role="menuitemradio" aria-checked={on} onClick={run}>
      <span className="ddt">{label}</span>
      {on && (
        <span className="ddk">
          <I n="check" s={15} />
        </span>
      )}
    </button>
  );
  const notifChoices = [
    choice("Activées", !muted, () => {
      mute(false);
      setSide(false);
      setPage("main");
      setStepped(page === "notif");
    }),
    choice("Coupées", muted, () => {
      mute(true);
      setSide(false);
      setPage("main");
      setStepped(page === "notif");
    }),
  ];

  return (
    <>
      <Dropdown
        anchor={props.anchor}
        start={roomy}
        center={!roomy}
        label={`Projet ${project.name}`}
        className={`pjm${roomy ? "" : " big"}${shown.leaving ? " out" : ""}`}
        onClose={onClose}
      >
        {page === "notif" ? (
          <div className="pjp fwd" key="notif">
            <button
              type="button"
              role="menuitem"
              className="pjb"
              onClick={() => {
                setPage("main");
                setStepped(true);
              }}
            >
              <span className="ddi">
                <I n="back" s={16} />
              </span>
              <span className="ddt">Notifications</span>
            </button>
            <hr />
            {notifChoices}
          </div>
        ) : (
          <div className={`pjp${page === "main" && stepped ? " bwd" : ""}`} key="main">
            {groups.map((g, i) => (
              <Fragment key={i}>
                {i > 0 && <hr />}
                {g.map((line) => (
                  <button
                    key={line.label}
                    ref={line.more ? notifRow : undefined}
                    type="button"
                    role="menuitem"
                    className={`${line.danger ? "dng" : ""}${line.more && side ? " kb" : ""}`}
                    aria-haspopup={line.more ? "menu" : undefined}
                    onClick={line.run}
                  >
                    <span className="ddi">
                      <I n={line.icon} s={roomy ? 16 : 20} />
                    </span>
                    <span className="ddt">{line.label}</span>
                    {line.value && <small>{line.value}</small>}
                    {line.more && (
                      <span className="ddi">
                        <I n="right" s={13} />
                      </span>
                    )}
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        )}
      </Dropdown>
      {roomy && side2.mounted && (
        <Dropdown
          anchor={notifRow}
          side
          label="Notifications"
          className={`pjm side${side2.leaving ? " out" : ""}`}
          onClose={() => setSide(false)}
        >
          {notifChoices}
        </Dropdown>
      )}
    </>
  );
}
