import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNow } from "../components.tsx";
import { prefersReducedMotion } from "../motion.tsx";
import { loadSession } from "../session.ts";
import "./waiting-room.css";

export type PlaceInLine = {
  offerId: string;
  status: "WAITING" | "ADMITTED" | "EXPIRED" | "USED";
  position: number | null;
  estimatedWaitMinutes: number | null;
  admissionExpiresAt?: string;
};

type Move = { at: number; position: number };

/** What this browser has seen of the line since joining. Saved for the tab so a reload keeps it. */
export type LineProgress = {
  ticket: string;
  startPosition: number;
  position: number;
  lastMovedAt: number;
  /** The most recent moves, oldest first. Starts again once the line has stood still. */
  moves: Move[];
  resumedAt?: number;
};

const progressKey = (offerId: string) => `moonshot-fest:line-progress:${offerId}`;
export const forgetLineProgress = (offerId: string) => sessionStorage.removeItem(progressKey(offerId));

/** How long the line may stand still before we say so: three times its usual gap between moves, and never under 45 seconds. */
function stallAfter(moves: Move[]): number {
  if (moves.length < 2) return 90_000;
  const usualGap = (moves[moves.length - 1]!.at - moves[0]!.at) / (moves.length - 1);
  return Math.max(45_000, usualGap * 3);
}

function pacePerMinute(moves: Move[]): number | undefined {
  if (moves.length < 2) return undefined;
  const first = moves[0]!;
  const last = moves[moves.length - 1]!;
  return last.at > first.at ? ((first.position - last.position) / (last.at - first.at)) * 60_000 : undefined;
}

function advance(previous: LineProgress | undefined, ticket: string, position: number, at: number): LineProgress {
  if (previous?.ticket !== ticket) return { ticket, startPosition: position, position, lastMovedAt: at, moves: [] };
  if (position === previous.position) return previous;
  if (position > previous.position) return { ...previous, startPosition: Math.max(previous.startPosition, position), position };
  const resumed = at - previous.lastMovedAt > stallAfter(previous.moves);
  return {
    ...previous,
    position,
    lastMovedAt: at,
    moves: resumed ? [{ at, position }] : [...previous.moves, { at, position }].slice(-6),
    resumedAt: resumed ? at : previous.resumedAt,
  };
}

/** Follows a place in line from one update to the next, so the page can show pace and notice when the line stands still. */
export function useLineProgress(offerId: string, ticket: string | undefined, place: PlaceInLine | undefined, updatedAt: number | undefined) {
  const [progress, setProgress] = useState(() => loadSession<LineProgress>(progressKey(offerId)));
  const position = place?.status === "WAITING" ? place.position : null;
  useEffect(() => {
    if (!ticket || position === null || !updatedAt) return;
    const next = advance(progress, ticket, position, updatedAt);
    if (next === progress) return;
    sessionStorage.setItem(progressKey(offerId), JSON.stringify(next));
    setProgress(next);
  }, [offerId, ticket, position, updatedAt, progress]);
  return progress?.ticket === ticket ? progress : undefined;
}

/** Counts from the previous number to the new one, so a change is easy to notice. */
function useCountTo(target: number): number {
  const [shown, setShown] = useState(target);
  const latest = useRef(target);
  useEffect(() => {
    const from = latest.current;
    if (from === target) return;
    if (prefersReducedMotion()) {
      latest.current = target;
      setShown(target);
      return;
    }
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - startedAt) / 700);
      latest.current = Math.round(from + (target - from) * (1 - (1 - progress) ** 3));
      setShown(latest.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/** Follows a value but changes at most once per interval, so screen readers aren't interrupted on every update. */
function useUnhurried<T>(value: T, intervalMs: number): T {
  const [held, setHeld] = useState(value);
  const changedAt = useRef(0);
  useEffect(() => {
    if (Object.is(value, held)) return;
    const timer = window.setTimeout(() => {
      changedAt.current = Date.now();
      setHeld(value);
    }, Math.max(0, changedAt.current + intervalMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [value, held, intervalMs]);
  return held;
}

const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const rest = `${String(Math.floor(seconds / 60) % 60).padStart(seconds >= 3600 ? 2 : 1, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${rest}` : rest;
};

const states = {
  joined: { label: "You're in line", note: "Keep this page open. Your place is saved, and the reserve form opens here when it's your turn." },
  moving: { label: "Line moving", note: "Keep this page open. Your place is saved, and the reserve form opens here when it's your turn." },
  stalled: { label: "Line not moving", note: "The line hasn't moved for a while. Your place is saved, so there's no need to join again. This page updates as soon as it moves." },
  offline: { label: "Reconnecting", note: "We can't update your place right now. Your place is saved, and we'll keep trying." },
};

export function WaitingRoom({ place, progress, passName, offline, onLeave }: {
  place: PlaceInLine;
  progress: LineProgress | undefined;
  passName: string;
  offline: boolean;
  onLeave: () => void;
}) {
  const now = useNow();
  const position = place.position;
  const shown = useCountTo(position ?? 0);
  const announced = useUnhurried(position, 30_000);

  const sinceMove = progress ? Math.max(0, now - progress.lastMovedAt) : 0;
  const stalled = !!progress && sinceMove > stallAfter(progress.moves);
  const state = offline ? "offline" : stalled ? "stalled" : progress?.moves.length ? "moving" : "joined";
  const pace = stalled ? 0 : progress && pacePerMinute(progress.moves);
  const resumed = !stalled && !!progress?.resumedAt && now - progress.resumedAt < 15_000;
  const hasMoved = !!progress && (progress.moves.length > 0 || !!progress.resumedAt);

  const ahead = position === null ? null : position - 1;
  const start = progress?.startPosition ?? position ?? 1;
  const movedUp = position === null ? 0 : Math.max(0, start - position);
  const done = position === null ? 0 : Math.min(1, movedUp / Math.max(1, start - 1));
  const wait = place.estimatedWaitMinutes;
  const text = position === null ? "…" : shown.toLocaleString("en-US");
  // The hash is drawn smaller than the digits and a comma is narrow, so they count for less when sizing the number to fit.
  const width = 0.7 + text.replace(/,/g, "").length + (text.includes(",") ? 0.4 : 0);

  return (
    <section className={`line-panel is-${state}`} aria-label="Your place in line">
      <p className="visually-hidden" role="status">
        {states[state].label}.{announced !== null && ` You are number ${announced.toLocaleString("en-US")} in line.`}
      </p>
      <span className="line-corner tr" aria-hidden="true" />
      <span className="line-corner bl" aria-hidden="true" />

      <header className="line-head">
        <p className="line-pill" aria-hidden="true"><span className="line-dot" />{states[state].label}</p>
        <p className="line-pass">{passName}</p>
      </header>

      {resumed && <p className="line-resumed" aria-hidden="true">The line is moving again</p>}

      <div className="line-body">
        <div className="line-place" style={{ "--chars": width } as CSSProperties}>
          <p className="line-kicker">Your place in line</p>
          <p key={position} className="line-number"><span className="line-hash">#</span>{text}</p>
          <p className="line-ahead">
            {ahead === null ? "Finding your place" : ahead === 0 ? "You're next" : `${ahead.toLocaleString("en-US")} ${ahead === 1 ? "guest" : "guests"} ahead of you`}
          </p>
        </div>

        <dl className="line-stats">
          <div className="line-stat-pace">
            <dt>Pace</dt>
            <dd>{pace === undefined ? "—" : <>{Math.round(pace)}<span>guests a minute</span></>}</dd>
          </div>
          <div className="line-stat-moved">
            <dt>{hasMoved ? "Last moved" : "Joined"}</dt>
            <dd>{progress ? <>{elapsed(sinceMove)}<span>ago</span></> : "—"}</dd>
          </div>
          <div className="line-stat-wait">
            <dt>Estimated wait</dt>
            <dd>
              {stalled ? "On hold"
                : wait === null ? "—"
                : wait <= 1 ? <>&lt;1<span>min</span></>
                : wait < 60 ? <>{wait}<span>min</span></>
                : <>{Math.round(wait / 60)}<span>hr</span></>}
            </dd>
          </div>
        </dl>
      </div>

      <div className="line-route">
        <div className="line-track" style={{ "--done": done } as CSSProperties} aria-hidden="true">
          <span className="line-track-fill" />
          <span className="line-track-you" />
          <span className="line-track-front" />
        </div>
        <p className="line-route-labels">
          <span>
            {movedUp > 0
              ? `Up ${movedUp.toLocaleString("en-US")} ${movedUp === 1 ? "place" : "places"} since you joined at #${start.toLocaleString("en-US")}`
              : `You joined at #${start.toLocaleString("en-US")}`}
          </span>
          <span>Front of the line</span>
        </p>
      </div>

      <footer className="line-foot">
        <p>{states[state].note}</p>
        <button type="button" className="text-button" onClick={onLeave}>Leave the line</button>
      </footer>
    </section>
  );
}
