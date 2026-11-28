import { describe, expect, it } from "vitest";
import { keyboardOf } from "./keyboard.ts";

// An iPhone 852 points tall, as in the recording the work started from.
const page = { height: 852, visible: 852, offsetTop: 0, scale: 1 };

describe("keyboardOf", () => {
  it("sees no keyboard on a page seen whole", () => {
    expect(keyboardOf(page)).toBeNull();
  });

  it("takes a browser's bar for what it is", () => {
    expect(keyboardOf({ ...page, visible: 852 - 50 })).toBeNull();
  });

  it("gives the keyboard's height, hidden at the bottom of a page left in place", () => {
    expect(keyboardOf({ ...page, visible: 466 })).toEqual({ height: 386, top: 0, inset: 386 });
  });

  it("counts what the system pushed the page up: less is hidden at its bottom", () => {
    expect(keyboardOf({ ...page, visible: 466, offsetTop: 200 })).toEqual({
      height: 386,
      top: 200,
      inset: 186,
    });
  });

  it("says a page pushed past the keyboard ends above it", () => {
    // The recording: the page pushed 430 points up for a keyboard of 386.
    expect(keyboardOf({ ...page, visible: 466, offsetTop: 430 })).toEqual({
      height: 386,
      top: 430,
      inset: -44,
    });
  });

  it("counts on the page as it is laid out, whatever the window says of its own height", () => {
    // An iPhone on iOS 26, as captured: 428 points seen, the page pushed 424 points up. Its
    // window then says it is 428 tall too, which is why no part of this reads it.
    expect(keyboardOf({ ...page, visible: 428, offsetTop: 424 })).toEqual({
      height: 424,
      top: 424,
      inset: 0,
    });
  });

  it("says nothing of a page zoomed with two fingers", () => {
    expect(keyboardOf({ ...page, visible: 426, offsetTop: 120, scale: 2 })).toBeNull();
  });

  it("rounds what a zoomed display gives in fractions", () => {
    expect(keyboardOf({ ...page, visible: 465.6, offsetTop: 0.4 })).toEqual({
      height: 386,
      top: 0,
      inset: 386,
    });
  });
});
