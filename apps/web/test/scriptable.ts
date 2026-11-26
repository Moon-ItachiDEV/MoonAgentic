// A stand-in for the Scriptable app (https://docs.scriptable.app), enough to run
// `public/widget-iphone.js` outside an iPhone: the widget it builds is kept as a tree, read as
// text by the tests and drawn as HTML to look at.
import { readFileSync } from "node:fs";

type Theme = "light" | "dark";

export class Color {
  readonly hex: string;
  readonly alpha: number;
  dark?: Color;
  constructor(hex: string, alpha = 1) {
    this.hex = hex;
    this.alpha = alpha;
  }
  static dynamic(light: Color, dark: Color): Color {
    const color = new Color(light.hex, light.alpha);
    color.dark = dark;
    return color;
  }
  static white(): Color {
    return new Color("#ffffff");
  }
  css(theme: Theme): string {
    const c = theme === "dark" && this.dark ? this.dark : this;
    const n = Number.parseInt(c.hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${c.alpha})`;
  }
}

export class Font {
  readonly size: number;
  readonly weight: number;
  readonly mono: boolean;
  constructor(size: number, weight: number, mono = false) {
    this.size = size;
    this.weight = weight;
    this.mono = mono;
  }
  static systemFont = (size: number) => new Font(size, 400);
  static mediumSystemFont = (size: number) => new Font(size, 500);
  static semiboldSystemFont = (size: number) => new Font(size, 600);
  static regularMonospacedSystemFont = (size: number) => new Font(size, 400, true);
}

export class Size {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}
export class Point {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}
export class Rect {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
  ) {}
}
export class Path {
  d = "";
  move(p: Point) {
    this.d += `M${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  addLine(p: Point) {
    this.d += `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
}

export interface Picture {
  svg?: string;
  url?: string;
}

export class DrawContext {
  size = new Size(0, 0);
  opaque = true;
  respectScreenScale = false;
  private width = 1;
  private stroke = new Color("#000000");
  private fill = new Color("#000000");
  private path: Path | undefined;
  private shapes = "";
  setLineWidth(width: number) {
    this.width = width;
  }
  setStrokeColor(color: Color) {
    this.stroke = color;
  }
  setFillColor(color: Color) {
    this.fill = color;
  }
  strokeEllipse(r: Rect) {
    this.shapes += `<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="none" stroke="${this.stroke.css("light")}" stroke-width="${this.width}"/>`;
  }
  fillEllipse(r: Rect) {
    this.shapes += `<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}" fill="${this.fill.css("light")}"/>`;
  }
  addPath(path: Path) {
    this.path = path;
  }
  strokePath() {
    this.shapes += `<path d="${this.path!.d}" fill="none" stroke="${this.stroke.css("light")}" stroke-width="${this.width}"/>`;
  }
  getImage(): Picture {
    const { width, height } = this.size;
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${this.shapes}</svg>`,
    };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const src = (p: Picture) =>
  p.url ?? `data:image/svg+xml;base64,${Buffer.from(p.svg ?? "").toString("base64")}`;

class WidgetText {
  font = Font.systemFont(16);
  textColor = new Color("#000000");
  lineLimit = 0;
  minimumScaleFactor = 1;
  textOpacity = 1;
  centred = false;
  constructor(readonly text: string) {}
  centerAlignText() {
    this.centred = true;
  }
  html(theme: Theme, mono: boolean): string {
    const clamp =
      this.lineLimit === 1
        ? "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        : this.lineLimit > 1
          ? `display:-webkit-box;-webkit-line-clamp:${this.lineLimit};-webkit-box-orient:vertical;overflow:hidden;`
          : "";
    const color = mono ? "#fff" : this.textColor.css(theme);
    return `<span style="font:${this.font.weight} ${this.font.size}px/1.2 ${this.font.mono ? "ui-monospace,monospace" : "-apple-system,Geist,system-ui,sans-serif"};color:${color};opacity:${this.textOpacity};min-width:0;${clamp}">${esc(this.text)}</span>`;
  }
}

class WidgetImage {
  imageSize: Size | undefined;
  cornerRadius = 0;
  imageOpacity = 1;
  constructor(readonly image: Picture) {}
  html(): string {
    const size = this.imageSize
      ? `width:${this.imageSize.width}px;height:${this.imageSize.height}px;`
      : "";
    return `<img src="${src(this.image)}" style="${size}border-radius:${this.cornerRadius}px;opacity:${this.imageOpacity};flex:none;object-fit:cover">`;
  }
}

class WidgetSpacer {
  constructor(readonly length: number | undefined) {}
}

export class WidgetStack {
  readonly children: (WidgetText | WidgetImage | WidgetSpacer | WidgetStack)[] = [];
  protected vertical = false;
  private align = "flex-start";
  size: Size | undefined;
  spacing = 0;
  cornerRadius = 0;
  backgroundColor: Color | undefined;
  backgroundImage: Picture | undefined;
  url: string | undefined;
  /** Top, right, bottom, left. */
  padding = [0, 0, 0, 0];
  layoutVertically() {
    this.vertical = true;
  }
  layoutHorizontally() {
    this.vertical = false;
  }
  centerAlignContent() {
    this.align = "center";
  }
  topAlignContent() {
    this.align = "flex-start";
  }
  bottomAlignContent() {
    this.align = "flex-end";
  }
  setPadding(top: number, left: number, bottom: number, right: number) {
    this.padding = [top, right, bottom, left];
  }
  addText(text: string) {
    if (typeof text !== "string") throw new TypeError("addText takes a string");
    const node = new WidgetText(text);
    this.children.push(node);
    return node;
  }
  addImage(image: Picture) {
    if (!image) throw new TypeError("addImage takes an image");
    const node = new WidgetImage(image);
    this.children.push(node);
    return node;
  }
  addSpacer(length?: number) {
    const node = new WidgetSpacer(length);
    this.children.push(node);
    return node;
  }
  addStack() {
    const node = new WidgetStack();
    this.children.push(node);
    return node;
  }
  /** Every text of the widget, in reading order. */
  texts(): string[] {
    return this.children.flatMap((c) =>
      c instanceof WidgetText ? [c.text] : c instanceof WidgetStack ? c.texts() : [],
    );
  }
  protected style(theme: Theme): string {
    const size = this.size
      ? `${this.size.width ? `width:${this.size.width}px;` : ""}${this.size.height ? `height:${this.size.height}px;` : ""}flex:none;`
      : "";
    const bg = this.backgroundColor ? `background-color:${this.backgroundColor.css(theme)};` : "";
    const image = this.backgroundImage
      ? `background-image:url('${src(this.backgroundImage)}');background-size:cover;`
      : "";
    // A horizontal stack centres its text on the cross axis when asked; a vertical one leads.
    return `display:flex;flex-direction:${this.vertical ? "column" : "row"};align-items:${this.align};${
      !this.vertical && this.size && this.align === "center" ? "justify-content:center;" : ""
    }gap:${this.spacing}px;padding:${this.padding.map((p) => `${p}px`).join(" ")};border-radius:${this.cornerRadius}px;min-width:0;box-sizing:border-box;${size}${bg}${image}`;
  }
  /** True when it takes all the width it is given: a row with a flexible spacer, or one inside. */
  private wide(): boolean {
    return this.children.some((c) =>
      c instanceof WidgetSpacer
        ? !this.vertical && c.length === undefined
        : c instanceof WidgetStack && c.wide(),
    );
  }
  html(theme: Theme, mono = false, inColumn = true): string {
    const grow = !this.wide() ? "" : inColumn ? "align-self:stretch;" : "flex:1 1 0;";
    const inner = this.children
      .map((c) => {
        if (c instanceof WidgetSpacer) {
          return c.length === undefined
            ? `<i style="flex:1 1 0"></i>`
            : `<i style="flex:none;${this.vertical ? "height" : "width"}:${c.length}px"></i>`;
        }
        if (c instanceof WidgetText) return c.html(theme, mono);
        if (c instanceof WidgetImage) return c.html();
        return c.html(theme, mono, this.vertical);
      })
      .join("");
    return `<div style="${this.style(theme)}${grow}">${inner}</div>`;
  }
}

export class ListWidget extends WidgetStack {
  refreshAfterDate: Date | undefined;
  addAccessoryWidgetBackground = false;
  presented: string | undefined;
  constructor() {
    super();
    this.vertical = true;
    this.padding = [16, 16, 16, 16];
  }
  async presentSmall() {
    this.presented = "small";
  }
  async presentMedium() {
    this.presented = "medium";
  }
  async presentLarge() {
    this.presented = "large";
  }
}

export interface Phone {
  /** What the server answers: a status and a body, for each address asked. */
  answer: (
    url: string,
    request: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    status: number;
    body?: string;
  };
  /** The answers typed into each alert in turn: the button's place, and the fields. */
  alerts?: { pick: number; fields?: string[] }[];
  keychain?: Map<string, string>;
  files?: Map<string, string | Picture | null>;
}

/** Runs the script as Scriptable would, in the app or as a widget; gives back what it showed. */
export async function runScript(
  file: string,
  phone: Phone,
  as: { family?: string; parameter?: string } = {},
): Promise<{
  widget: ListWidget | undefined;
  keychain: Map<string, string>;
  alerts: { title: string; message: string; actions: string[] }[];
  asked: string[];
}> {
  const keychain = phone.keychain ?? new Map<string, string>();
  const files = phone.files ?? new Map<string, string | Picture | null>();
  const alerts = [...(phone.alerts ?? [])];
  const shown: { title: string; message: string; actions: string[] }[] = [];
  const asked: string[] = [];
  let widget: ListWidget | undefined;

  class Request {
    method = "GET";
    headers: Record<string, string> = {};
    body: string | undefined;
    timeoutInterval = 60;
    response: { statusCode: number } | undefined;
    constructor(readonly url: string) {}
    private send() {
      asked.push(`${this.method} ${this.url}`);
      const answer = phone.answer(this.url, {
        method: this.method,
        headers: this.headers,
        ...(this.body !== undefined ? { body: this.body } : {}),
      });
      if (answer.status === 0) throw new Error("The request timed out.");
      this.response = { statusCode: answer.status };
      return answer.body ?? "";
    }
    async loadString() {
      return this.send();
    }
    async loadJSON() {
      return JSON.parse(this.send()) as unknown;
    }
    /** What is not an image comes back as nothing, as on an iPhone. */
    async loadImage(): Promise<Picture | null> {
      this.send();
      return this.response?.statusCode === 200 ? { url: this.url } : null;
    }
  }
  class Alert {
    title = "";
    message = "";
    private readonly actions: string[] = [];
    private readonly fields: string[] = [];
    private typed: string[] = [];
    addAction(label: string) {
      this.actions.push(label);
    }
    addCancelAction(_label: string) {}
    addTextField(_placeholder: string, text = "") {
      this.fields.push(text);
    }
    textFieldValue(place: number) {
      return this.typed[place] ?? this.fields[place] ?? "";
    }
    private present() {
      shown.push({ title: this.title, message: this.message, actions: this.actions });
      const next = alerts.shift() ?? { pick: 0 };
      this.typed = next.fields ?? [];
      return next.pick;
    }
    async presentAlert() {
      return this.present();
    }
    async presentSheet() {
      return this.present();
    }
  }
  const globals = {
    Color,
    Font,
    Size,
    Point,
    Rect,
    Path,
    DrawContext,
    ListWidget,
    Request,
    Alert,
    Keychain: {
      contains: (key: string) => keychain.has(key),
      get: (key: string) => keychain.get(key),
      set: (key: string, value: string) => void keychain.set(key, value),
    },
    FileManager: {
      local: () => ({
        cacheDirectory: () => "/cache",
        joinPath: (a: string, b: string) => `${a}/${b}`,
        fileExists: (path: string) => files.has(path),
        readString: (path: string) => files.get(path) as string,
        writeString: (path: string, text: string) => void files.set(path, text),
        readImage: (path: string) => (files.get(path) ?? null) as Picture | null,
        writeImage: (path: string, image: Picture | null) => void files.set(path, image),
      }),
    },
    Script: {
      setWidget: (w: ListWidget) => {
        widget = w;
      },
      complete: () => undefined,
    },
    config: {
      runsInWidget: !!as.family && !as.family.startsWith("accessory"),
      runsInAccessoryWidget: !!as.family?.startsWith("accessory"),
      widgetFamily: as.family,
    },
    args: { widgetParameter: as.parameter ?? null },
  };
  const made: ListWidget[] = [];
  const Tracked = class extends ListWidget {
    constructor() {
      super();
      made.push(this);
    }
  };
  const AsyncFunction = (async () => undefined).constructor as new (
    ...parts: string[]
  ) => (...values: unknown[]) => Promise<void>;
  const names = Object.keys(globals);
  await new AsyncFunction(...names, readFileSync(file, "utf8"))(
    ...names.map((name) =>
      name === "ListWidget" ? Tracked : globals[name as keyof typeof globals],
    ),
  );
  return { widget: widget ?? made.find((w) => w.presented), keychain, alerts: shown, asked };
}
