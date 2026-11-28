// Springs as iOS draws them: a perceived duration and a bounce instead of a fixed curve. A
// value that moves this way always has a position and a speed, so sending it somewhere else
// half way starts from both: nothing ever jumps or stops dead. The motion is worked out
// ahead (`frames`) and handed to the browser as keyframes, which its compositor plays: it
// stays smooth where a script-driven animation would be held back (an iPhone saving power).

export interface Spring {
  /** How long the move feels, in seconds. */
  duration: number;
  /** 0: settles without passing its target. 0.2: passes it a little, once. */
  bounce: number;
}

/** A position and a speed, per second. */
export type Motion = readonly [position: number, speed: number];

/**
 * Where a spring is `t` seconds after leaving `distance` away from its target at `speed`:
 * the distance left, and the speed.
 */
export function springAt(spring: Spring, distance: number, speed: number, t: number): Motion {
  if (t <= 0) return [distance, speed];
  const omega = (2 * Math.PI) / spring.duration;
  const damping = 1 - Math.min(Math.max(spring.bounce, 0), 0.95);
  if (damping >= 1) {
    const c = speed + omega * distance;
    const decay = Math.exp(-omega * t);
    return [(distance + c * t) * decay, (speed - omega * c * t) * decay];
  }
  const a = damping * omega;
  const wd = omega * Math.sqrt(1 - damping * damping);
  const b = (speed + a * distance) / wd;
  const decay = Math.exp(-a * t);
  const cos = Math.cos(wd * t);
  const sin = Math.sin(wd * t);
  return [
    decay * (distance * cos + b * sin),
    decay * (speed * cos - (a * b + distance * wd) * sin),
  ];
}

/** How long after it starts a spring is at rest for the eye, in seconds. */
export const settleTime = (spring: Spring): number => spring.duration * 2.2;

/** A value over time: where it is and how fast it goes at a time in seconds. */
export interface Track {
  at(t: number): Motion;
  /** The time from which it no longer moves. */
  end: number;
}

/** A value that stays where it is. */
export const still = (position: number): Track => ({ at: () => [position, 0], end: 0 });

/**
 * The same value sent to `target` from `start` on: it leaves from where it then is, at the
 * speed it then has. Until `start` it goes on as before. (A track keeps the one it came from:
 * whoever holds tracks replaces them with `still` once they rest.)
 */
export function send(track: Track, target: number, spring: Spring, start: number): Track {
  const [from, speed] = track.at(start);
  return {
    at(t) {
      if (t < start) return track.at(t);
      const [left, v] = springAt(spring, from - target, speed, t - start);
      return [target + left, v];
    },
    end: start + settleTime(spring),
  };
}

/**
 * A value seen `position` away from its place at `speed`, brought back to it (0): what a part
 * of the page does when the layout moved it and it must be seen travelling there.
 */
export const settle = (position: number, speed: number, spring: Spring, start: number): Track =>
  send({ at: () => [position, speed], end: start }, 0, spring, start);

/** The same value, `by` seconds later. */
export const later = (track: Track, by: number): Track =>
  by === 0 ? track : { at: (t) => track.at(t - by), end: track.end + by };

/**
 * The time, in seconds, on the clock the browser draws its animations by. Tracks are timed on
 * that one, not on the wall's: a picture is drawn for a time of this clock, and a busy page
 * draws it well after the wall's has passed it. Picked up where the wall's clock has it, a
 * move would be further on than its last picture showed it: seen, a jump. (The wall's all the
 * same where a browser has no such clock.)
 */
export function clock(): number {
  const drawn = typeof document === "undefined" ? null : document.timeline?.currentTime;
  return (typeof drawn === "number" ? drawn : performance.now()) / 1000;
}

/**
 * The times to draw a motion at, from `now` until `end`: one every 1/90 s, and a last one
 * late enough for everything to be exactly at rest.
 */
export function frames(now: number, end: number): { times: number[]; duration: number } {
  const duration = Math.max(0.05, end - now);
  const count = Math.ceil(duration * 90);
  const times: number[] = [];
  for (let i = 0; i < count; i++) times.push(now + (duration * i) / count);
  times.push(now + duration + 1000);
  return { times, duration };
}

/**
 * The time on its tracks a motion is seen at when the clock says `now`. Its keyframes were
 * drawn from `since` on, but the browser plays them from the picture it starts them at, one
 * or more after they were made, and shows the first of them until then: what is on screen is
 * that far behind the clock. A change of mind leaves from what is on screen. With nothing
 * `playing`, the clock is right.
 */
export function seenAt(now: number, since: number, playing: readonly Animation[]): number {
  if (!playing.length) return now;
  for (const { startTime } of playing)
    if (typeof startTime === "number") return Math.max(since, since + now - startTime / 1000);
  return since;
}
