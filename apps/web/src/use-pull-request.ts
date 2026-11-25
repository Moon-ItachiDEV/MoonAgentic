import type { PullRequestInfo, Thread } from "@moonagentic/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { connection, newId } from "./connection.ts";
import { prStates } from "./pr-states.ts";

/** How often GitHub is asked again while an open pull request is on screen. */
const REFRESH_MS = 20_000;

/**
 * The pull request of the thread's branch, as GitHub describes it: asked on opening, after
 * each push (`stamp` changes), then again every few seconds while it is open.
 */
export function usePullRequest(thread: Thread, stamp: unknown) {
  const [pr, setPr] = useState<PullRequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const asking = useRef(false);
  const branch = thread.workspace?.base ? thread.workspace.branch : undefined;

  const take = useCallback((reply: { pr?: PullRequestInfo; error?: string }) => {
    setPr(reply.pr ?? null);
    setError(reply.error ?? null);
    if (reply.pr) prStates.learn(reply.pr.url, reply.pr.state);
  }, []);

  /** Set when asked again while an answer is on its way: that answer may already be stale. */
  const again = useRef(false);
  const refresh = useCallback(async () => {
    if (!branch) return;
    if (asking.current) {
      again.current = true;
      return;
    }
    asking.current = true;
    setLoading(true);
    try {
      do {
        again.current = false;
        const reply = await connection.ask({
          type: "workspace.pr",
          requestId: newId(),
          threadId: thread.id,
        });
        take(reply);
      } while (again.current);
    } catch {
      // no connection right now: what was last known stays, the next round asks again
    } finally {
      asking.current = false;
      setLoading(false);
    }
  }, [branch, thread.id, take]);

  useEffect(() => {
    setPr(null);
    setError(null);
  }, [thread.id]);
  useEffect(() => {
    void refresh();
  }, [refresh, stamp]);

  const live = pr?.state === "open" || pr?.state === "draft";
  useEffect(() => {
    if (!live) return;
    const again = () => document.visibilityState === "visible" && void refresh();
    const timer = setInterval(again, REFRESH_MS);
    document.addEventListener("visibilitychange", again);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", again);
    };
  }, [live, refresh]);

  const merge = useCallback(async () => {
    if (!pr) return;
    const reply = await connection.ask({
      type: "workspace.mergePr",
      requestId: newId(),
      threadId: thread.id,
      number: pr.number,
      head: pr.head,
    });
    if (reply.error) {
      // What GitHub refused is shown in the box; the state behind it is read again.
      void refresh();
      throw new Error(reply.error);
    }
    take(reply);
  }, [pr, thread.id, refresh, take]);

  return { pr, error, loading, refresh, merge };
}
