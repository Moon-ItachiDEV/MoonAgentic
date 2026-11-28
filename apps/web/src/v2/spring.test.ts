import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clock,
  frames,
  later,
  seenAt,
  send,
  settle,
  settleTime,
  type Spring,
  springAt,
  still,
} from "./spring.ts";

const SMOOTH: Spring = { duration: 0.42, bounce: 0 };
const BOUNCY: Spring = { duration: 0.5, bounce: 0.2 };

describe("springAt", () => {
  it("leaves from the distance and the speed it is given", () => {
    expect(springAt(SMOOTH, 120, -300, 0)).toEqual([120, -300]);
    expect(springAt(BOUNCY, 120, -300, 0)).toEqual([120, -300]);
  });

  it("is at its target, at rest, once settled", () => {
    for (const spring of [SMOOTH, BOUNCY]) {
      const [left, speed] = springAt(spring, 400, 0, settleTime(spring));
      expect(Math.abs(left)).toBeLessThan(0.05);
      expect(Math.abs(speed)).toBeLessThan(1);
    }
  });

  it("never passes its target without bounce", () => {
    for (let t = 0; t <= 1.2; t += 0.004) {
      expect(springAt(SMOOTH, 1, 0, t)[0]).toBeGreaterThanOrEqual(0);
    }
  });

  it("passes its target a little with a slight bounce, once", () => {
    let lowest = 0;
    for (let t = 0; t <= 1.5; t += 0.002) lowest = Math.min(lowest, springAt(BOUNCY, 1, 0, t)[0]);
    expect(lowest).toBeLessThan(-0.005);
    expect(lowest).toBeGreaterThan(-0.05);
  });

  it("gives the speed its position really has", () => {
    for (const spring of [SMOOTH, BOUNCY]) {
      for (const t of [0.01, 0.08, 0.2, 0.45]) {
        const h = 1e-5;
        const slope =
          (springAt(spring, 200, 150, t + h)[0] - springAt(spring, 200, 150, t - h)[0]) / (2 * h);
        expect(springAt(spring, 200, 150, t)[1]).toBeCloseTo(slope, 2);
      }
    }
  });

  it("moves most of the way in the first third of its time, as a keyboard does", () => {
    expect(springAt(SMOOTH, 1, 0, 0.2)[0]).toBeLessThan(0.25);
    expect(springAt(SMOOTH, 1, 0, 0.42)[0]).toBeLessThan(0.02);
  });
});

describe("send", () => {
  it("goes to the target from a value at rest", () => {
    const track = send(still(0), 1, SMOOTH, 10);
    expect(track.at(10)).toEqual([0, 0]);
    expect(track.at(10 + settleTime(SMOOTH))[0]).toBeCloseTo(1, 3);
    expect(track.end).toBeCloseTo(10 + settleTime(SMOOTH));
  });

  it("turns back from where it is, at the speed it has: no jump, no dead stop", () => {
    const up = send(still(0), 1, SMOOTH, 0);
    const [position, speed] = up.at(0.09);
    expect(speed).toBeGreaterThan(1);
    const back = send(up, 0, SMOOTH, 0.09);
    expect(back.at(0.09)[0]).toBeCloseTo(position, 10);
    expect(back.at(0.09)[1]).toBeCloseTo(speed, 10);
    // Still carried by its speed for an instant, then on its way back.
    expect(back.at(0.1)[0]).toBeGreaterThan(position);
    expect(back.at(0.09 + settleTime(SMOOTH))[0]).toBeCloseTo(0, 3);
  });

  it("goes on as before until a later start", () => {
    const leaving = send(still(0), 1, SMOOTH, 0);
    const returning = send(leaving, 0, BOUNCY, 0.3);
    expect(returning.at(0.1)).toEqual(leaving.at(0.1));
    expect(returning.at(0.3)[0]).toBeCloseTo(leaving.at(0.3)[0], 10);
    expect(returning.at(0.3 + settleTime(BOUNCY))[0]).toBeCloseTo(0, 3);
  });
});

describe("settle", () => {
  it("brings back to its place what is seen away from it, keeping its speed", () => {
    const track = settle(260, -900, SMOOTH, 5);
    expect(track.at(5)).toEqual([260, -900]);
    expect(Math.abs(track.at(5 + settleTime(SMOOTH))[0])).toBeLessThan(0.05);
  });
});

describe("frames", () => {
  it("draws ninety times a second, and a last time with everything at rest", () => {
    const { times, duration } = frames(2, 3);
    expect(duration).toBe(1);
    expect(times).toHaveLength(91);
    expect(times[0]).toBe(2);
    expect(times[1]! - times[0]!).toBeCloseTo(1 / 90);
    const track = send(still(0), 1, SMOOTH, 2);
    expect(track.at(times.at(-1)!)).toEqual([1, 0]);
  });

  it("is never shorter than a moment", () => {
    expect(frames(2, 1).duration).toBe(0.05);
  });
});

describe("later", () => {
  it("has the same value that much after", () => {
    const track = send(still(0), 1, SMOOTH, 3);
    const late = later(track, 0.25);
    expect(late.at(3.5)).toEqual(track.at(3.25));
    expect(late.at(3.25)).toEqual([0, 0]);
    expect(late.end).toBe(track.end + 0.25);
  });

  it("is the track itself when no time passed", () => {
    const track = send(still(0), 1, SMOOTH, 3);
    expect(later(track, 0)).toBe(track);
  });
});

describe("clock", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the one the browser draws its animations by", () => {
    vi.stubGlobal("document", { timeline: { currentTime: 2500 } });
    expect(clock()).toBe(2.5);
  });

  it("is the wall's where the browser has none", () => {
    for (const document of [undefined, {}, { timeline: { currentTime: null } }]) {
      vi.stubGlobal("document", document);
      const before = performance.now() / 1000;
      const now = clock();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(performance.now() / 1000);
    }
  });
});

describe("seenAt", () => {
  /** Keyframes the browser started at a picture drawn for that time (ms), or has not yet. */
  const playing = (...startTimes: (number | null)[]) =>
    startTimes.map((startTime) => ({ startTime }) as Animation);

  it("is the clock's time when nothing plays", () => {
    expect(seenAt(12, 3, [])).toBe(12);
  });

  it("is behind the clock by as long as the browser took to start the keyframes", () => {
    // Drawn from 10 s on, started at the picture of 10.05 s: at 10.2 s the screen has what the
    // tracks have at 10.15 s.
    expect(seenAt(10.2, 10, playing(10_050))).toBeCloseTo(10.15, 10);
  });

  it("is the first keyframe until the browser has started them", () => {
    expect(seenAt(10.2, 10, playing(null, null))).toBe(10);
    expect(seenAt(10.02, 10, playing(10_050))).toBe(10);
  });

  it("goes by the keyframes that are started when some are not", () => {
    expect(seenAt(10.2, 10, playing(null, 10_050))).toBeCloseTo(10.15, 10);
  });

  it("turns a move back from what is on screen, not from where the clock has it", () => {
    const since = 10;
    const up = send(still(0), 1, SMOOTH, since);
    // What the picture drawn for a time shows: the browser started the keyframes 50 ms late.
    const shown = (time: number) => up.at(since + time - 10.05);
    // The mind changes when the clock says 10.15 s.
    const now = 10.15;
    const seen = seenAt(now, since, playing(10_050));
    const back = send(later(up, now - seen), 0, SMOOTH, now);
    expect(back.at(now)[0]).toBeCloseTo(shown(now)[0], 10);
    expect(back.at(now)[1]).toBeCloseTo(shown(now)[1], 10);
    // The clock alone has it a fifth of the way further: turned back from there, it would jump.
    expect(up.at(now)[0]).toBeGreaterThan(shown(now)[0] + 0.2);
    expect(back.at(now + settleTime(SMOOTH))[0]).toBeCloseTo(0, 3);
  });
});
