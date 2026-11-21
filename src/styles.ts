import { type Signal, signal } from "@c9up/aurora/core";
import { OrbitError } from "./errors.js";
import type { Style } from "./node.js";

/**
 * Styles from the app's own Tailwind build.
 *
 * `ream android:build` runs Tailwind over the app as its web build does, and
 * compiles the stylesheet into a table (`ream css:compile`): every utility
 * rule with its declarations already resolved against the theme (lengths in
 * px, colours as `#rrggbbaa`, light and dark), its variant as conditions, and
 * the custom properties classes compose at run time (`--tw-shadow`,
 * `--tw-leading`…) left as `var()`. This applies the table to orbit's tree
 * the way a browser applies the stylesheet: rules matched by class and
 * condition, cascaded by specificity then order, custom properties resolved,
 * and the result read into the host's style keys.
 */

type SchemeValue = string | { light: string; dark: string };

export type StyleCondition =
	| { attribute: string; equals: string | null }
	| { attribute: string; operator: "*" | "^" | "$" | "~" | "|"; value: string }
	| { state: string }
	| { scheme: "dark" }
	| { class: string }
	| { not: StyleCondition[] }
	| { any: StyleCondition[] }
	| { all: StyleCondition[] }
	| { ancestor: Relative }
	| { parent: Relative }
	| { previous: Relative }
	| { previousAdjacent: Relative }
	| { has: string }
	| { position: string; of?: string }
	| { dir: string };

interface Relative {
	classes: string[];
	when: StyleCondition[];
}

type Target =
	| "self"
	| { pseudo: string }
	| {
			relation: "child" | "descendant";
			tag: string | null;
			when: StyleCondition[];
			pseudo: string | null;
	  };

export interface StyleRule {
	/** The utility class it belongs to; absent for an element rule. */
	class?: string;
	/** A rule of the base layer: a tag, or `*` for every element. */
	element?: string;
	when?: StyleCondition[];
	target?: Target;
	media?: { minWidth?: number; maxWidth?: number };
	specificity: number;
	declarations: Array<[string, SchemeValue]>;
}

export interface StyleTable {
	version: 1;
	properties: { [name: string]: { initial: string | null; inherits: boolean } };
	rules: StyleRule[];
	inert: string[];
}

/** What the resolver reads of an element: all reactive reads. */
export interface StyledElement {
	/** The tag; the root answers to `html` and `body` as well (`root`). */
	readonly tag: string;
	readonly root?: boolean;
	classes(): readonly string[];
	/** The attribute's value, `""` when present without one, null when absent. */
	attribute(name: string): string | null;
	readonly parent: StyledElement | null;
	/** The element sibling just before this one, if any. */
	readonly previous: StyledElement | null;
	/** Custom properties this element passes down (resolved), set once computed. */
	vars?: ReadonlyMap<string, string>;
}

/** An element's computed style, read into the host's keys. */
export interface Computed {
	box: Style;
	text: Style;
	/** `display: flex` / `inline-flex`: each child its own item, a row by default. */
	flex: boolean;
	/** `overflow(-y): auto | scroll`. */
	scroll: boolean;
	/** `::placeholder`'s colour, for a text field. */
	placeholder?: string;
	vars: ReadonlyMap<string, string>;
}

interface Indexed {
	rule: StyleRule;
	order: number;
}

let selfRules = new Map<string, Indexed[]>();
let elementRules = new Map<string, Indexed[]>();
let relatedRules = new Map<string, Indexed[]>();
let known = new Set<string>();
let properties: StyleTable["properties"] = {};

/** Classes an element asked for that the app's stylesheet does not have. */
export const unknownClasses = new Set<string>();

/** The scheme `dark:` and the theme's dark values follow. */
export const colorScheme: Signal<"light" | "dark"> = signal<"light" | "dark">(
	"light",
);

/** The viewport, for `sm:` / `md:` and `vw` / `vh` (set by `mount`). */
export const viewportSize: Signal<{ width: number; height: number }> = signal({
	width: 0,
	height: 0,
});

const isObject = (v: unknown): v is { [key: string]: unknown } =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function isRule(v: unknown): v is StyleRule {
	return (
		isObject(v) &&
		(typeof v.class === "string" || typeof v.element === "string") &&
		typeof v.specificity === "number" &&
		Array.isArray(v.declarations)
	);
}

/** A table `ream css:compile` wrote, checked rather than trusted (it is a file read at run time). */
export function isStyleTable(v: unknown): v is StyleTable {
	return (
		isObject(v) &&
		v.version === 1 &&
		isObject(v.properties) &&
		Array.isArray(v.rules) &&
		v.rules.every(isRule) &&
		Array.isArray(v.inert)
	);
}

/** Give orbit the app's style table (`ream android:*` does it before the app runs). */
export function useStyles(table: unknown): void {
	if (!isStyleTable(table)) {
		throw new OrbitError(
			"E_ORBIT_STYLE_TABLE",
			"[orbit] not a style table orbit reads (version 1, from ream css:compile)",
		);
	}
	selfRules = new Map();
	relatedRules = new Map();
	elementRules = new Map();
	known = new Set(table.inert);
	properties = table.properties;
	table.rules.forEach((rule, order) => {
		if (rule.class === undefined) {
			const tag = rule.element ?? "*";
			const list = elementRules.get(tag) ?? [];
			list.push({ rule, order });
			elementRules.set(tag, list);
			return;
		}
		known.add(rule.class);
		const into =
			rule.target === undefined ||
			rule.target === "self" ||
			!("relation" in rule.target)
				? selfRules
				: relatedRules;
		const list = into.get(rule.class) ?? [];
		list.push({ rule, order });
		into.set(rule.class, list);
	});
	unknownClasses.clear();
}

// ─── Matching ────────────────────────────────────────────────────────

function matches(el: StyledElement, rel: Relative): boolean {
	const classes = el.classes();
	return (
		rel.classes.every((c) => classes.includes(c)) &&
		rel.when.every((cond) => holds(cond, el))
	);
}

function holds(cond: StyleCondition, el: StyledElement): boolean {
	if ("attribute" in cond) {
		const value =
			cond.attribute === "class"
				? el.classes().join(" ")
				: el.attribute(cond.attribute);
		if ("operator" in cond) {
			if (value === null) return false;
			switch (cond.operator) {
				case "*":
					return value.includes(cond.value);
				case "^":
					return value.startsWith(cond.value);
				case "$":
					return value.endsWith(cond.value);
				case "~":
					return value.split(/\s+/).includes(cond.value);
				default:
					return value === cond.value || value.startsWith(`${cond.value}-`);
			}
		}
		return cond.equals === null ? value !== null : value === cond.equals;
	}
	if ("scheme" in cond) return colorScheme() === cond.scheme;
	if ("class" in cond) return el.classes().includes(cond.class);
	if ("not" in cond) return !cond.not.every((c) => holds(c, el));
	if ("any" in cond) return cond.any.some((c) => holds(c, el));
	if ("all" in cond) return cond.all.every((c) => holds(c, el));
	if ("ancestor" in cond) {
		for (let a = el.parent; a; a = a.parent)
			if (matches(a, cond.ancestor)) return true;
		return false;
	}
	if ("parent" in cond)
		return el.parent !== null && matches(el.parent, cond.parent);
	if ("previous" in cond) {
		for (let p = el.previous; p; p = p.previous)
			if (matches(p, cond.previous)) return true;
		return false;
	}
	if ("previousAdjacent" in cond)
		return el.previous !== null && matches(el.previous, cond.previousAdjacent);
	if ("dir" in cond) return cond.dir === "ltr";
	// A touch screen is never hovered; orbit does not see :has() or positions yet.
	return false;
}

function mediaHolds(media: StyleRule["media"]): boolean {
	if (!media) return true;
	const { width } = viewportSize();
	if (media.minWidth !== undefined && width < media.minWidth) return false;
	if (media.maxWidth !== undefined && width > media.maxWidth) return false;
	return true;
}

interface Hit {
	specificity: number;
	order: number;
	declarations: StyleRule["declarations"];
	pseudo: string | null;
}

/** The rules that apply to `el`, in cascade order. */
function hits(el: StyledElement): Hit[] {
	const out: Hit[] = [];
	// The base layer's element rules: `*`, the tag, and html / body at the root.
	const tags = el.root ? ["*", el.tag, "html", "body"] : ["*", el.tag];
	for (const tag of tags) {
		for (const { rule, order } of elementRules.get(tag) ?? []) {
			if (!(rule.when ?? []).every((c) => holds(c, el))) continue;
			const pseudo =
				typeof rule.target === "object" &&
				"pseudo" in rule.target &&
				!("relation" in rule.target)
					? rule.target.pseudo
					: null;
			out.push({
				specificity: rule.specificity,
				order,
				declarations: rule.declarations,
				pseudo,
			});
		}
	}
	for (const cls of el.classes()) {
		const list = selfRules.get(cls);
		if (!list) {
			if (!known.has(cls)) unknownClasses.add(cls);
			continue;
		}
		for (const { rule, order } of list) {
			if (!mediaHolds(rule.media)) continue;
			if (!(rule.when ?? []).every((c) => holds(c, el))) continue;
			const pseudo =
				typeof rule.target === "object" &&
				"pseudo" in rule.target &&
				!("relation" in rule.target)
					? rule.target.pseudo
					: null;
			out.push({
				specificity: rule.specificity,
				order,
				declarations: rule.declarations,
				pseudo,
			});
		}
	}
	// Rules an ancestor's class aims at its children or descendants (`[&_svg]:`, `*:`).
	for (let a = el.parent, depth = 0; a; a = a.parent, depth++) {
		for (const cls of a.classes()) {
			for (const { rule, order } of relatedRules.get(cls) ?? []) {
				const target = rule.target;
				if (typeof target !== "object" || !("relation" in target)) continue;
				if (target.relation === "child" && depth > 0) continue;
				if (target.tag !== null && target.tag !== el.tag) continue;
				if (!mediaHolds(rule.media)) continue;
				if (!target.when.every((c) => holds(c, el))) continue;
				if (!(rule.when ?? []).every((c) => holds(c, a))) continue;
				out.push({
					specificity: rule.specificity,
					order,
					declarations: rule.declarations,
					pseudo: target.pseudo,
				});
			}
		}
	}
	out.sort((x, y) => x.specificity - y.specificity || x.order - y.order);
	return out;
}

// ─── Values ──────────────────────────────────────────────────────────

function pick(value: SchemeValue): string {
	return typeof value === "string" ? value : value[colorScheme()];
}

/** `)` matching the `(` before `from`. */
function closing(s: string, from: number): number {
	let depth = 1;
	for (let i = from; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")" && --depth === 0) return i;
	}
	return -1;
}

/** Substitute `var()`; null when one resolves to nothing (invalid at computed time). */
function substitute(
	value: string,
	lookup: (name: string) => string | null,
	depth = 0,
): string | null {
	if (depth > 16) return null;
	let out = "";
	let rest = value;
	for (;;) {
		const at = rest.indexOf("var(");
		if (at < 0) return out + rest;
		const end = closing(rest, at + 4);
		if (end < 0) return null;
		out += rest.slice(0, at);
		const inner = rest.slice(at + 4, end);
		const comma = inner.indexOf(",");
		const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
		const own = lookup(name);
		const raw = own ?? (comma < 0 ? null : inner.slice(comma + 1));
		if (raw === null) return null;
		const resolved = substitute(raw, lookup, depth + 1);
		if (resolved === null) return null;
		out += resolved;
		rest = rest.slice(end + 1);
	}
}

/** `calc()` over px, % and numbers, once `var()`s are gone. */
function evaluateCalc(value: string): string {
	let rest = value;
	let at = rest.indexOf("calc(");
	while (at >= 0) {
		const end = closing(rest, at + 5);
		if (end < 0) return rest;
		const result = arithmetic(rest.slice(at + 5, end));
		const text = result === null ? `calc(${rest.slice(at + 5, end)})` : result;
		rest = rest.slice(0, at) + text + rest.slice(end + 1);
		at = rest.indexOf("calc(", at + (result === null ? 5 : text.length));
	}
	return rest;
}

function arithmetic(expr: string): string | null {
	const tokens = expr.match(/-?\d*\.?\d+(?:e-?\d+)?(?:px|%)?|[-+*/()]/g);
	if (!tokens) return null;
	let pos = 0;
	type Q = { n: number; unit: string };
	const atom = (): Q | null => {
		const t = tokens[pos++];
		if (t === undefined) return null;
		if (t === "(") {
			const q = sum();
			pos++;
			return q;
		}
		const m = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|%)?$/.exec(t);
		return m ? { n: Number(m[1]), unit: m[2] ?? "" } : null;
	};
	const product = (): Q | null => {
		let q = atom();
		while (q && (tokens[pos] === "*" || tokens[pos] === "/")) {
			const op = tokens[pos++];
			const r = atom();
			if (!r) return null;
			if (op === "*") q = { n: q.n * r.n, unit: q.unit || r.unit };
			else if (r.unit === "" && r.n !== 0) q = { n: q.n / r.n, unit: q.unit };
			else return null;
		}
		return q;
	};
	const sum = (): Q | null => {
		let q = product();
		while (q && (tokens[pos] === "+" || tokens[pos] === "-")) {
			const op = tokens[pos++];
			const r = product();
			if (!r) return null;
			const unit =
				q.unit === r.unit || r.n === 0 ? q.unit : q.n === 0 ? r.unit : null;
			if (unit === null) return null;
			q = { n: op === "+" ? q.n + r.n : q.n - r.n, unit };
		}
		return q;
	};
	const q = sum();
	if (!q || pos !== tokens.length) return null;
	return `${Math.round(q.n * 10000) / 10000}${q.unit}`;
}

/** Split at top-level commas or spaces. */
function split(value: string, by: "," | " "): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (depth === 0 && (by === "," ? c === "," : /\s/.test(c ?? ""))) {
			const part = value.slice(start, i).trim();
			if (part) out.push(part);
			start = i + 1;
		}
	}
	const last = value.slice(start).trim();
	if (last) out.push(last);
	return out;
}

const isColor = (v: string) =>
	/^#[0-9a-f]{8}$/i.test(v) || v === "currentcolor";

/** `#rrggbbaa` to the `#rrggbb` / `rgba()` orbit's colour reader takes. */
function cssColor(v: string, current: string | undefined): string | undefined {
	if (v === "currentcolor") return current;
	// What the build could not mix: the text colour faded over transparent
	// (`color-mix(in oklab, currentcolor 50%, transparent)`).
	const mix =
		/^color-mix\(in [a-z]+,\s*(currentcolor|#[0-9a-f]{8})\s+([\d.]+)%,\s*#00000000\)$/i.exec(
			v,
		);
	if (mix) {
		const base =
			mix[1] === "currentcolor" ? current : cssColor(mix[1] ?? "", current);
		if (base === undefined) return undefined;
		return withAlpha(base, Number(mix[2]) / 100);
	}
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(v);
	if (!m) return undefined;
	const alpha = Number.parseInt(m[2] ?? "ff", 16) / 255;
	if (alpha >= 1) return `#${m[1]}`;
	const n = Number.parseInt(m[1] ?? "0", 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 1000) / 1000})`;
}

/** A colour orbit writes (`#rrggbb` or `rgba()`) with its alpha scaled. */
function withAlpha(css: string, factor: number): string {
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 1;
	const hex = /^#([0-9a-f]{6})$/i.exec(css);
	const rgba =
		/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(css);
	if (hex) {
		const n = Number.parseInt(hex[1] ?? "0", 16);
		[r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	} else if (rgba) {
		[r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
		a = rgba[4] === undefined ? 1 : Number(rgba[4]);
	}
	return `rgba(${r}, ${g}, ${b}, ${Math.round(a * factor * 1000) / 1000})`;
}

function length(v: string, fontSize: number): number | string | undefined {
	if (v === "auto") return "auto";
	if (v.endsWith("%")) return v;
	const m = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|em|vw|vh|dvh|svh|lvh)?$/.exec(v);
	if (!m) return undefined;
	const n = Number(m[1]);
	switch (m[2]) {
		case undefined:
		case "px":
			return n;
		case "em":
			return n * fontSize;
		case "vw":
			return (n / 100) * viewportSize().width;
		default:
			return (n / 100) * viewportSize().height;
	}
}

const ALIGN: { [v: string]: string } = {
	start: "flex-start",
	"flex-start": "flex-start",
	end: "flex-end",
	"flex-end": "flex-end",
	center: "center",
	stretch: "stretch",
	baseline: "baseline",
	normal: "stretch",
	"space-between": "space-between",
	"space-around": "space-around",
	"space-evenly": "space-evenly",
};

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

/** `a`, `a b`, `a b c` or `a b c d` → top, right, bottom, left. */
function fourSides(values: string[]): [string, string, string, string] | null {
	const [a, b = a, c = a, d = b] = values;
	return a === undefined ||
		b === undefined ||
		c === undefined ||
		d === undefined
		? null
		: [a, b, c, d];
}

const TEXT_KEYS = new Set([
	"color",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"fontFamily",
	"textAlign",
	"lineHeight",
	"letterSpacing",
]);

/** One declaration into the host's keys (`out`); what orbit does not draw is skipped. */
function apply(
	prop: string,
	v: string,
	out: Style,
	state: {
		flex: boolean;
		scroll: boolean;
		fontSize: number;
		weight: number;
		color?: string;
	},
): void {
	const len = (x: string) => length(x, state.fontSize);
	const set = (key: string, x: string | number | undefined) => {
		if (x !== undefined) out[key] = x;
	};
	const sides = (prefix: string, suffix: string, value: string) => {
		const four = fourSides(split(value, " "));
		if (!four) return;
		four.forEach((x, i) => {
			set(`${prefix}${SIDES[i]}${suffix}`, len(x));
		});
	};
	switch (prop) {
		case "display":
			// The host lays every box out as flex; only `none` is sent.
			if (v === "none") out.display = "none";
			else delete out.display;
			state.flex = v === "flex" || v === "inline-flex";
			return;
		case "width":
		case "height":
		case "min-width":
		case "min-height":
		case "max-width":
		case "max-height": {
			if (v === "none" || /content$/.test(v)) return;
			const key = prop.replace(/-(\w)/, (_, c: string) => c.toUpperCase());
			set(key, len(v));
			return;
		}
		case "padding":
		case "margin":
			sides(prop, "", v);
			return;
		case "padding-inline":
		case "margin-inline":
		case "padding-block":
		case "margin-block": {
			const [a, b = a] = split(v, " ");
			const base = prop.startsWith("padding") ? "padding" : "margin";
			const [x, y] = prop.endsWith("inline")
				? ["Left", "Right"]
				: ["Top", "Bottom"];
			if (a !== undefined && b !== undefined) {
				set(`${base}${x}`, len(a));
				set(`${base}${y}`, len(b));
			}
			return;
		}
		case "padding-block-start":
		case "padding-block-end":
		case "padding-inline-start":
		case "padding-inline-end":
		case "margin-block-start":
		case "margin-block-end":
		case "margin-inline-start":
		case "margin-inline-end":
		case "padding-top":
		case "padding-right":
		case "padding-bottom":
		case "padding-left":
		case "margin-top":
		case "margin-right":
		case "margin-bottom":
		case "margin-left": {
			const [base = "", ...rest] = prop.split("-");
			const where = rest.join("-");
			const side =
				{
					"block-start": "Top",
					"block-end": "Bottom",
					"inline-start": "Left",
					"inline-end": "Right",
				}[where] ?? `${where.charAt(0).toUpperCase()}${where.slice(1)}`;
			set(`${base}${side}`, len(v));
			return;
		}
		case "inset":
			sides("", "", v);
			for (const s of SIDES) {
				const k = s;
				if (out[k] !== undefined) {
					out[k.toLowerCase()] = out[k];
					delete out[k];
				}
			}
			return;
		case "inset-inline":
		case "inset-block": {
			const [a, b = a] = split(v, " ");
			const [x, y] =
				prop === "inset-inline" ? ["left", "right"] : ["top", "bottom"];
			if (a !== undefined && b !== undefined) {
				set(x, len(a));
				set(y, len(b));
			}
			return;
		}
		case "top":
		case "right":
		case "bottom":
		case "left":
			set(prop, len(v));
			return;
		case "inset-inline-start":
			set("left", len(v));
			return;
		case "inset-inline-end":
			set("right", len(v));
			return;
		case "gap":
		case "row-gap":
		case "column-gap": {
			const [a, b = a] = split(v, " ");
			if (prop === "gap" && a !== undefined && b !== undefined) {
				set("rowGap", len(a));
				set("columnGap", len(b));
			} else set(prop === "row-gap" ? "rowGap" : "columnGap", len(v));
			return;
		}
		case "flex": {
			const parts = split(v, " ");
			if (v === "none")
				Object.assign(out, { flexGrow: 0, flexShrink: 0, flexBasis: "auto" });
			else if (v === "auto")
				Object.assign(out, { flexGrow: 1, flexShrink: 1, flexBasis: "auto" });
			else {
				const [grow, shrink = "1", basis = "0%"] = parts;
				set("flexGrow", Number(grow));
				set("flexShrink", Number(shrink));
				set("flexBasis", len(basis));
			}
			return;
		}
		case "flex-grow":
			set("flexGrow", Number(v));
			return;
		case "flex-shrink":
			set("flexShrink", Number(v));
			return;
		case "flex-basis":
			set("flexBasis", len(v));
			return;
		case "flex-direction":
			set("flexDirection", v);
			return;
		case "flex-wrap":
			set("flexWrap", v);
			return;
		case "align-items":
		case "align-self":
		case "align-content":
		case "justify-content": {
			const key = prop.replace(/-(\w)/, (_, c: string) => c.toUpperCase());
			set(key, ALIGN[v.replace(/^safe /, "")]);
			return;
		}
		case "position":
			set(
				"position",
				v === "absolute" || v === "fixed" ? "absolute" : "relative",
			);
			return;
		case "overflow":
		case "overflow-y":
		case "overflow-x":
			if (v === "auto" || v === "scroll") {
				if (prop !== "overflow-x") state.scroll = true;
			} else if (v === "hidden" || v === "clip") out.overflow = "hidden";
			return;
		case "aspect-ratio": {
			const [a, b] = v.split("/").map((x) => Number(x.trim()));
			if (a !== undefined && Number.isFinite(a))
				set("aspectRatio", b !== undefined && b > 0 ? a / b : a);
			return;
		}
		case "border-width":
			sides("border", "Width", v);
			if (new Set(SIDES.map((s) => out[`border${s}Width`])).size === 1)
				for (const s of SIDES) {
					out.borderWidth = out[`border${s}Width`] ?? 0;
					delete out[`border${s}Width`];
				}
			return;
		case "border-top-width":
		case "border-right-width":
		case "border-bottom-width":
		case "border-left-width": {
			const side = prop.split("-")[1] ?? "";
			set(`border${side.charAt(0).toUpperCase()}${side.slice(1)}Width`, len(v));
			return;
		}
		case "border-style":
			if (v === "none" || v === "hidden") out.borderStyleNone = 1;
			else delete out.borderStyleNone;
			return;
		case "border-color":
		case "border-top-color":
		case "border-bottom-color":
		case "border-left-color":
		case "border-right-color": {
			const [first] = split(v, " ");
			if (first !== undefined) set("borderColor", cssColor(first, state.color));
			return;
		}
		case "border-radius": {
			const [first] = split(v, " ");
			if (first !== undefined) set("borderRadius", len(first));
			return;
		}
		case "background-color":
			set("backgroundColor", cssColor(v, state.color));
			return;
		case "color": {
			const c = cssColor(v, state.color);
			if (c) {
				out.color = c;
				state.color = c;
			}
			return;
		}
		case "opacity":
			set(
				"opacity",
				v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v),
			);
			return;
		case "font-size": {
			const n = len(v);
			if (typeof n === "number") {
				out.fontSize = n;
				state.fontSize = n;
			}
			return;
		}
		case "font-weight": {
			// bolder / lighter: CSS's relative weights, from the inherited one.
			const w = state.weight;
			const weight =
				v === "bold"
					? 700
					: v === "normal"
						? 400
						: v === "bolder"
							? w < 350
								? 400
								: w < 550
									? 700
									: 900
							: v === "lighter"
								? w < 550
									? 100
									: w < 750
										? 400
										: 700
								: Number(v);
			if (Number.isFinite(weight)) {
				out.fontWeight = String(weight);
				state.weight = weight;
			}
			return;
		}
		case "font-style":
			set("fontStyle", v);
			return;
		case "font-family":
			if (/mono/.test(v)) out.fontFamily = "monospace";
			return;
		case "line-height": {
			// Unitless: a multiple of the font size, kept so it follows a size set later.
			if (/^\d*\.?\d+$/.test(v)) set("lineHeight", `${v}x`);
			else set("lineHeight", len(v));
			return;
		}
		case "letter-spacing":
			set("letterSpacing", len(v));
			return;
		case "text-align":
			set("textAlign", v === "start" ? "left" : v === "end" ? "right" : v);
			return;
		case "object-fit":
			set("objectFit", v);
			return;
		case "field-sizing":
			set("fieldSizing", v);
			return;
		case "backdrop-filter": {
			const m = /blur\(([\d.]+)px\)/.exec(v);
			if (m) set("backdropBlur", Number(m[1]));
			return;
		}
		case "box-shadow":
			shadow(v, out, state.color);
			return;
		default:
			return;
	}
}

/** The first visible outer shadow of a `box-shadow` list (orbit draws one). */
function shadow(v: string, out: Style, current: string | undefined): void {
	for (const layer of split(v, ",")) {
		const parts = split(layer, " ");
		if (parts.includes("inset")) continue;
		const color = parts.find(isColor);
		const numbers = parts.filter((p) => !isColor(p)).map((p) => length(p, 16));
		if (!color || numbers.some((n) => typeof n !== "number")) continue;
		const [x = 0, y = 0, blur = 0, spread = 0] = numbers.map(Number);
		const css = cssColor(color, current);
		if (!css || (/^#[0-9a-f]{8}$/i.test(color) && color.endsWith("00")))
			continue;
		if (x === 0 && y === 0 && blur === 0 && spread === 0) continue;
		Object.assign(out, {
			shadowX: x,
			shadowY: y,
			shadowBlur: blur,
			shadowSpread: spread,
			shadowColor: css,
		});
		return;
	}
}

/**
 * Equal sides back into one key (`padding`, `marginHorizontal`, `gap`), and
 * nothing the host already assumes (a zero margin or padding, a border colour
 * without a border): the base layer sets those on every element.
 */
function compact(style: Style): void {
	for (const [key, value] of Object.entries(style))
		if (value === 0 && /^(margin|padding)/.test(key)) delete style[key];
	const bordered = [
		"borderWidth",
		"borderTopWidth",
		"borderRightWidth",
		"borderBottomWidth",
		"borderLeftWidth",
	].some((k) => typeof style[k] === "number" && style[k] !== 0);
	if (!bordered) delete style.borderColor;
	for (const base of ["padding", "margin"]) {
		const [t, r, b, l] = SIDES.map((side) => style[`${base}${side}`]);
		if (t !== undefined && t === r && r === b && b === l) {
			for (const side of SIDES) delete style[`${base}${side}`];
			style[base] = t;
			continue;
		}
		if (l !== undefined && l === r) {
			delete style[`${base}Left`];
			delete style[`${base}Right`];
			style[`${base}Horizontal`] = l;
		}
		if (t !== undefined && t === b) {
			delete style[`${base}Top`];
			delete style[`${base}Bottom`];
			style[`${base}Vertical`] = t;
		}
	}
	if (style.rowGap !== undefined && style.rowGap === style.columnGap) {
		style.gap = style.rowGap;
		delete style.rowGap;
		delete style.columnGap;
	}
}

/**
 * `el`'s style: the table's rules cascaded, custom properties resolved, read
 * into the host's keys. `inherited` is the text style it inherits (and its
 * colour, for `currentcolor`).
 */
export function computeStyle(el: StyledElement, inherited: Style): Computed {
	const own = new Map<string, string>();
	const declared: Array<[string, string]> = [];
	const placeholder: Array<[string, string]> = [];
	for (const hit of hits(el)) {
		for (const [prop, value] of hit.declarations) {
			const v = pick(value);
			if (hit.pseudo === "placeholder") placeholder.push([prop, v]);
			else if (hit.pseudo !== null) continue;
			else if (prop.startsWith("--")) own.set(prop, v);
			else declared.push([prop, v]);
		}
	}
	const parentVars = el.parent?.vars;
	const resolving = new Set<string>();
	const lookup = (name: string): string | null => {
		const mine = own.get(name);
		if (mine !== undefined) {
			if (resolving.has(name)) return null;
			resolving.add(name);
			const r = substitute(mine, lookup);
			resolving.delete(name);
			return r;
		}
		const registered = properties[name];
		if (!registered || registered.inherits) {
			const up = parentVars?.get(name);
			if (up !== undefined) return up;
		}
		return registered?.initial ?? null;
	};
	const vars = new Map<string, string>();
	for (const name of own.keys()) {
		const r = lookup(name);
		if (r !== null) vars.set(name, r);
	}
	if (parentVars) {
		for (const [name, value] of parentVars) {
			const registered = properties[name];
			if (!vars.has(name) && (!registered || registered.inherits))
				vars.set(name, value);
		}
	}
	const inheritedSize = inherited.fontSize;
	const inheritedColor = inherited.color;
	const inheritedWeight = Number(inherited.fontWeight ?? 400);
	const state = {
		flex: false,
		scroll: false,
		fontSize: typeof inheritedSize === "number" ? inheritedSize : 16,
		weight: Number.isFinite(inheritedWeight) ? inheritedWeight : 400,
		color: typeof inheritedColor === "string" ? inheritedColor : undefined,
	};
	const style: Style = {};
	// font-size, color and font-weight first: em lengths, currentcolor and
	// bolder read them.
	const first = (p: string) =>
		p === "font-size" || p === "color" || p === "font-weight";
	const ordered = [
		...declared.filter(([p]) => first(p)),
		...declared.filter(([p]) => !first(p)),
	];
	for (const [prop, raw] of ordered) {
		const v = substitute(raw, lookup);
		if (v === null) continue;
		apply(prop, evaluateCalc(v).trim(), style, state);
	}
	compact(style);
	if (style.borderStyleNone !== undefined) {
		delete style.borderStyleNone;
		style.borderWidth = 0;
	}
	const box: Style = {};
	const text: Style = {};
	for (const [key, value] of Object.entries(style)) {
		(TEXT_KEYS.has(key) ? text : box)[key] = value;
	}
	if (state.flex && box.flexDirection === undefined) box.flexDirection = "row";
	const computed: Computed = {
		box,
		text,
		flex: state.flex,
		scroll: state.scroll,
		vars,
	};
	for (const [prop, raw] of placeholder) {
		const v = substitute(raw, lookup);
		if (prop === "color" && v !== null)
			computed.placeholder = cssColor(v.trim(), state.color);
	}
	return computed;
}
