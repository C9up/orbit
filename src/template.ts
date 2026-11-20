/**
 * aurora templates as native views. `html` only returns `{strings, values}`;
 * this is the native counterpart of aurora's DOM compiler.
 *
 * Mapping (web semantics kept where native differs):
 * - block elements → RCTView; p / h1–h6 / label → RCTText; inline elements → RCTVirtualText.
 * - Text sitting in a view (illegal on native) is wrapped in an anonymous RCTText.
 * - Text styles cascade like CSS inheritance; views carry only box styles.
 * - In a flex container every child is its own item; `flex` is a row, as on the web.
 */

import { effect, isTemplateResult, untrack } from "@c9up/aurora/core";
import {
	assertBindable,
	readComponentLifecycle,
	setOwner,
	type TemplateResult,
	TemplateScanner,
} from "@c9up/aurora/renderer";
import {
	afterCommit,
	type MountOptions,
	mountTree,
	type Root,
} from "./commit.js";
import { OrbitError } from "./errors.js";
import {
	bindMotion,
	bindScrollY,
	type MotionStyle,
	MotionValue,
	readMotion,
} from "./motion.js";
import {
	type Child,
	flatten,
	NativeNode,
	Region,
	rawText,
	type Style,
} from "./node.js";
import { isScrollContainer, splitScroll, tw } from "./tailwind.js";

type Part = string | number; // number = index into the template's values
type TAttr = { name: string; parts: Part[] };
type TElement = { kind: "el"; tag: string; attrs: TAttr[]; children: TNode[] };
type TNode = TElement | { kind: "text"; parts: Part[] };

const OPEN = "";
const CLOSE = "";
const SLOT = /(\d+)/;
const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);
const TEXT_BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "label"]);
const INLINE = new Set([
	"span",
	"strong",
	"b",
	"em",
	"i",
	"small",
	"code",
	"a",
]);
const UNSUPPORTED = new Set(["select", "svg", "canvas", "iframe"]);

// Tailwind's preflight resets headings; only these keep a user-agent look.
const TAG_TEXT: { [tag: string]: Style } = {
	strong: { fontWeight: "700" },
	b: { fontWeight: "700" },
	em: { fontStyle: "italic" },
	i: { fontStyle: "italic" },
	small: { fontSize: 13 },
	code: { fontFamily: "monospace" },
};

const ENTITIES: { [name: string]: string } = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	nbsp: " ",
};

const decode = (s: string) =>
	s.replace(
		/&(amp|lt|gt|quot|#39|nbsp);/g,
		(_, name: string) => ENTITIES[name] ?? "",
	);

function splitParts(raw: string): Part[] {
	const out: Part[] = [];
	raw.split(SLOT).forEach((piece, i) => {
		if (i % 2 === 1) out.push(Number(piece));
		else if (piece) out.push(decode(piece));
	});
	return out;
}

// ─── Parsing ─────────────────────────────────────────────────────

const astCache = new WeakMap<TemplateStringsArray, TNode[]>();

function parse(strings: TemplateStringsArray): TNode[] {
	const hit = astCache.get(strings);
	if (hit) return hit;

	// Same refusals as the web path: aurora's own scanner vets every slot position.
	const scanner = new TemplateScanner();
	for (let i = 0; i < strings.length - 1; i++) {
		scanner.consume(strings[i] ?? "");
		assertBindable(scanner);
	}

	let s = strings[0] ?? "";
	for (let i = 1; i < strings.length; i++)
		s += `${OPEN}${i - 1}${CLOSE}${strings[i] ?? ""}`;

	const root: TNode[] = [];
	const stack: { tag: string; children: TNode[] }[] = [
		{ tag: "", children: root },
	];
	const top = () => stack[stack.length - 1] ?? { tag: "", children: root };
	let i = 0;
	while (i < s.length) {
		if (s.startsWith("<!--", i)) {
			const end = s.indexOf("-->", i + 4);
			i = end < 0 ? s.length : end + 3;
		} else if (s.startsWith("</", i)) {
			const end = s.indexOf(">", i);
			const name = s
				.slice(i + 2, end)
				.trim()
				.toLowerCase();
			while (stack.length > 1 && stack.pop()?.tag !== name) {
				/* pop up to the matching open tag */
			}
			i = end + 1;
		} else if (s.charAt(i) === "<" && /[a-zA-Z]/.test(s.charAt(i + 1))) {
			let j = i + 1;
			while (/[a-zA-Z0-9-]/.test(s.charAt(j))) j++;
			const tag = s.slice(i + 1, j).toLowerCase();
			const attrs: TAttr[] = [];
			let selfClosing = false;
			while (j < s.length) {
				while (/\s/.test(s.charAt(j))) j++;
				if (s.charAt(j) === ">") {
					j++;
					break;
				}
				if (s.startsWith("/>", j)) {
					selfClosing = true;
					j += 2;
					break;
				}
				let k = j;
				while (
					k < s.length &&
					!/[\s=>]/.test(s.charAt(k)) &&
					!s.startsWith("/>", k)
				)
					k++;
				const name = s.slice(j, k);
				j = k;
				let value = "";
				if (s.charAt(j) === "=") {
					j++;
					const quote = s.charAt(j);
					if (quote === '"' || quote === "'") {
						const end = s.indexOf(quote, j + 1);
						value = s.slice(j + 1, end);
						j = end + 1;
					} else {
						let end = j;
						while (end < s.length && !/[\s>]/.test(s.charAt(end))) end++;
						value = s.slice(j, end);
						j = end;
					}
				}
				attrs.push({ name, parts: splitParts(value) });
			}
			const el: TElement = { kind: "el", tag, attrs, children: [] };
			top().children.push(el);
			if (!selfClosing && !VOID.has(tag))
				stack.push({ tag, children: el.children });
			i = j;
		} else {
			let end = s.indexOf("<", i + 1);
			if (end < 0) end = s.length;
			// CSS-like whitespace: runs collapse; edges are trimmed later, at block boundaries.
			const collapsed = s.slice(i, end).replace(/\s+/g, " ");
			if (collapsed.trim())
				top().children.push({ kind: "text", parts: splitParts(collapsed) });
			i = end;
		}
	}
	trimAtBlocks(root);
	astCache.set(strings, root);
	return root;
}

const isBlock = (n: TNode | undefined) =>
	n === undefined || (n.kind === "el" && !INLINE.has(n.tag));

// A space next to a block boundary renders nothing in CSS; next to inline content it stays.
function trimAtBlocks(children: TNode[]): void {
	children.forEach((n, i) => {
		if (n.kind === "el") {
			trimAtBlocks(n.children);
			return;
		}
		const first = n.parts[0];
		if (isBlock(children[i - 1]) && typeof first === "string")
			n.parts[0] = first.trimStart();
		const lastIndex = n.parts.length - 1;
		const last = n.parts[lastIndex];
		if (isBlock(children[i + 1]) && typeof last === "string")
			n.parts[lastIndex] = last.trimEnd();
		n.parts = n.parts.filter((p) => p !== "");
	});
}

// ─── Values ──────────────────────────────────────────────────────

const isGetter = (v: unknown): v is () => unknown => typeof v === "function";
const isPrimitive = (v: unknown) =>
	v === null || (typeof v !== "object" && typeof v !== "function");

function str(v: unknown): string {
	if (v === null || v === undefined || v === false) return "";
	return typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean" ||
		typeof v === "bigint"
		? String(v)
		: "";
}

// Disposers of the reactive scope being built: a Region tears them down when
// its slot re-runs, so replaced subtrees release their signal subscriptions.
let collecting: Array<() => void> | null = null;

function ownLifecycle(result: TemplateResult): void {
	const lifecycle = readComponentLifecycle(result);
	if (!lifecycle) return;
	const scope = collecting;
	scope?.push(...lifecycle.cleanups);
	afterCommit(() => {
		for (const hook of lifecycle.mountHooks) {
			const teardown = hook();
			if (typeof teardown === "function") scope?.push(teardown);
		}
	});
}

function region(
	slot: () => unknown,
	build: (value: unknown) => Child[],
): Region {
	const out = new Region();
	let disposers: Array<() => void> = [];
	effect(() => {
		const value = slot();
		untrack(() => {
			for (const dispose of disposers.splice(0)) dispose();
			const scope: Array<() => void> = [];
			const prevOwner = setOwner(scope);
			const prevCollecting = collecting;
			collecting = scope;
			try {
				out.set(build(value));
			} finally {
				collecting = prevCollecting;
				setOwner(prevOwner);
			}
			disposers = scope;
		});
	});
	return out;
}

// ─── Instantiation ───────────────────────────────────────────────

type Attrs = {
	className: string | (() => string);
	onClick: (() => void) | null;
	motion: MotionStyle | null;
	scrollY: MotionValue | null;
};

function readAttrs(el: TElement, values: readonly unknown[]): Attrs {
	const attrs: Attrs = {
		className: "",
		onClick: null,
		motion: null,
		scrollY: null,
	};
	for (const attr of el.attrs) {
		if (attr.name === "class") {
			const reactive = attr.parts.some(
				(p) => typeof p === "number" && isGetter(values[p]),
			);
			const compute = () =>
				attr.parts
					.map((p) => {
						if (typeof p === "string") return p;
						const v = values[p];
						return str(isGetter(v) ? v() : v);
					})
					.join("");
			attrs.className = reactive ? compute : compute();
		} else if (attr.name === "@click") {
			const slot = attr.parts[0];
			const handler = typeof slot === "number" ? values[slot] : undefined;
			if (isGetter(handler)) attrs.onClick = () => void handler();
		} else if (attr.name === "motion" || attr.name === "scroll-y") {
			const slot = attr.parts[0];
			const value = typeof slot === "number" ? values[slot] : undefined;
			if (attr.name === "motion") attrs.motion = readMotion(value);
			else if (value instanceof MotionValue) attrs.scrollY = value;
			else
				throw new OrbitError(
					"E_ORBIT_INVALID_SCROLL_BINDING",
					"[orbit] scroll-y expects a motion value",
				);
		}
		// Other attributes (id, aria-*, data-*) have no native meaning yet (accessibility: later).
	}
	return attrs;
}

function bindClass(
	node: NativeNode,
	attrs: Attrs,
	base: Style,
	pick: (s: ReturnType<typeof tw>) => Style,
): Style {
	const { className } = attrs;
	if (typeof className === "string") return { ...base, ...pick(tw(className)) };
	let previous: Style = {};
	let initial: Style = {};
	let first = true;
	effect(() => {
		const next = { ...base, ...pick(tw(className())) };
		if (first) {
			initial = next;
			first = false;
		} else {
			const patch = flatten(next);
			for (const key of Object.keys(previous))
				if (!(key in next)) patch[key] = null;
			node.setProps(patch);
		}
		previous = next;
	});
	return initial;
}

const isFlexContainer = (classes: string) =>
	/(^|\s)(inline-)?flex(\s|$)/.test(classes);

// ─── Press ───────────────────────────────────────────────────────

type Point = {
	pageX: number;
	pageY: number;
	locationX: number;
	locationY: number;
};

function touchPoint(payload: unknown): Point | null {
	if (typeof payload !== "object" || payload === null) return null;
	const changed: unknown = Reflect.get(payload, "changedTouches");
	const touch: unknown = Array.isArray(changed) ? changed[0] : payload;
	if (typeof touch !== "object" || touch === null) return null;
	const read = (key: string) => {
		const v: unknown = Reflect.get(touch, key);
		return typeof v === "number" ? v : 0;
	};
	return {
		pageX: read("pageX"),
		pageY: read("pageY"),
		locationX: read("locationX"),
		locationY: read("locationY"),
	};
}

// A finger that travels further than this is scrolling or swiping, not pressing.
const PRESS_SLOP = 10;
// `@click` as a press: it fires on release only if the touch stayed put and was
// not taken over (a scroll view claiming the gesture sends touchCancel). Press
// feedback (ripple, highlight) is to come with native gesture recognition.
function withEvents(node: NativeNode, attrs: Attrs): NativeNode {
	const { onClick } = attrs;
	if (!onClick) return node;
	let origin: Point | null = null;
	const release = () => {
		origin = null;
	};
	node.onEvent = (type, payload) => {
		const point = touchPoint(payload);
		if (type === "topTouchStart" && point) {
			origin = point;
		} else if (type === "topTouchMove" && origin && point) {
			if (
				Math.hypot(point.pageX - origin.pageX, point.pageY - origin.pageY) >
				PRESS_SLOP
			)
				release();
		} else if (type === "topTouchEnd") {
			const pressed = origin !== null;
			release();
			if (pressed) onClick();
		} else if (type === "topTouchCancel") {
			release();
		}
	};
	return node;
}

function withMotion(node: NativeNode, attrs: Attrs): NativeNode {
	const { motion } = attrs;
	if (motion) afterCommit(() => bindMotion(node.tag, motion));
	return node;
}

// A scrolling element: RCTScrollView (the viewport) around a content view
// that carries the element's padding, gap and flow.
function scrollElement(
	el: TElement,
	values: readonly unknown[],
	inherited: Style,
	attrs: Attrs,
	classes: string,
): NativeNode {
	const split = tw(classes);
	const { outer, content } = splitScroll(split.box);
	const container = new NativeNode(
		"RCTView",
		flatten(content),
		viewChildren(
			el.children,
			values,
			{ ...inherited, ...split.text },
			isFlexContainer(classes),
		),
	);
	const node = new NativeNode("RCTScrollView", flatten(outer), [container]);
	const { scrollY } = attrs;
	if (scrollY) afterCommit(() => bindScrollY(node.tag, scrollY));
	return withMotion(node, attrs);
}

// ─── Text fields ─────────────────────────────────────────────────

/** An attribute's value: its single slot's value, or its parts joined. */
function attrValue(attr: TAttr, values: readonly unknown[]): unknown {
	const [only] = attr.parts;
	if (attr.parts.length === 1 && typeof only === "number") return values[only];
	return attr.parts
		.map((p) => (typeof p === "string" ? p : str(values[p])))
		.join("");
}

const KEYBOARDS: { [type: string]: string } = {
	email: "email",
	number: "numeric",
	tel: "phone",
	url: "url",
	search: "search",
	numeric: "numeric",
	decimal: "decimal",
};

// What CSS gives a placeholder by default (slate-400 in nebula's theme).
const PLACEHOLDER = "#94a3b8";

/** The event a field handler receives: the shape DOM handlers read. */
function fieldEvent(type: string, value: string, key?: string) {
	const target = { value };
	return { type, key, target, currentTarget: target };
}

function call(handler: unknown, event: unknown): void {
	if (typeof handler === "function") handler(event);
}

/**
 * `<input>` / `<textarea>`: a native text field. The field owns its text while
 * the user types — nothing round-trips through JS before a character shows —
 * and reports each change; a bound value is sent back only when it differs
 * from what the field last reported, so the caret never jumps.
 */
function inputElement(
	el: TElement,
	values: readonly unknown[],
	inherited: Style,
	attrs: Attrs,
): NativeNode {
	const raw = new Map<string, unknown>();
	for (const attr of el.attrs) raw.set(attr.name, attrValue(attr, values));
	const type = str(raw.get("type") ?? "text").toLowerCase();
	const multiline = el.tag === "textarea";
	const rowsAttr = Number(str(raw.get("rows")));
	const maxLength = Number(str(raw.get("maxlength")));
	const inputmode = str(raw.get("inputmode")).toLowerCase();
	const node = new NativeNode("OrbitTextInput", {}, []);
	const style = bindClass(node, attrs, { ...inherited }, (s) => ({
		...s.text,
		...s.box,
	}));
	const bound = raw.get(".value") ?? raw.get("value");
	let lastNative = isGetter(bound) ? str(untrack(bound)) : str(bound);
	let version = 0;
	node.props = {
		...flatten({ placeholderColor: PLACEHOLDER, ...style }),
		placeholder: str(raw.get("placeholder")),
		multiline,
		rows:
			Number.isFinite(rowsAttr) && rowsAttr > 0 ? rowsAttr : multiline ? 2 : 1,
		secure: type === "password",
		keyboard: KEYBOARDS[inputmode] ?? KEYBOARDS[type] ?? "text",
		maxLength: Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 0,
		editable: !raw.has("disabled") || raw.get("disabled") === false,
		autocomplete: str(raw.get("autocomplete")),
		text: lastNative,
		textVersion: version,
	};
	if (isGetter(bound)) {
		let first = true;
		effect(() => {
			const next = str(bound());
			if (first) {
				first = false;
				return;
			}
			if (next === lastNative) return;
			lastNative = next;
			version += 1;
			// A field sized by its content is measured on what it now holds:
			// cleared after a send, it shrinks back.
			node.setProps(
				node.props.fieldSizing === "content"
					? { text: next, textVersion: version, measureText: next }
					: { text: next, textVersion: version },
			);
		});
	}
	let atFocus = lastNative;
	node.onEvent = (eventType, payload) => {
		const text: unknown =
			typeof payload === "object" && payload !== null
				? Reflect.get(payload, "text")
				: undefined;
		const value = typeof text === "string" ? text : lastNative;
		if (eventType === "topChange") {
			lastNative = value;
			// A field sized by its content grows with its lines: the host
			// measures this text (layout only — the field already shows it).
			if (node.props.fieldSizing === "content")
				node.setProps({ measureText: value });
			call(raw.get("@input"), fieldEvent("input", value));
		} else if (eventType === "topFocus") {
			atFocus = value;
			call(raw.get("@focus"), fieldEvent("focus", value));
		} else if (eventType === "topBlur") {
			if (value !== atFocus)
				call(raw.get("@change"), fieldEvent("change", value));
			call(raw.get("@blur"), fieldEvent("blur", value));
		} else if (eventType === "topSubmit") {
			call(raw.get("@keydown"), fieldEvent("keydown", value, "Enter"));
		}
	};
	return withMotion(node, attrs);
}

// ─── Images ──────────────────────────────────────────────────────

// Bytes handed to an image are numbered so that new bytes reload the view
// even under the same node.
let bytesVersion = 0;

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Where `src` points, in the form the host loads: `https://…`, `file:<path>`,
 * `content://…` (what Android's pickers return), `asset:<name>` for a file
 * bundled with the app, or `bytes:<n>` for bytes the app hands over (they are
 * sent to the host's memory at the next commit, never written to disk).
 */
function imageSource(node: NativeNode, value: unknown): string {
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		node.pendingBytes =
			value instanceof Uint8Array ? value : new Uint8Array(value);
		bytesVersion += 1;
		return `bytes:${bytesVersion}`;
	}
	node.pendingBytes = null;
	const src = str(value).trim();
	if (src === "") return "";
	const scheme = SCHEME.exec(src)?.[1]?.toLowerCase();
	if (scheme === undefined) {
		return src.startsWith("/")
			? `file:${src}`
			: `asset:${src.replace(/^\.\//, "")}`;
	}
	if (scheme === "https" || scheme === "content") return src;
	if (scheme === "file") {
		// file:///data/x.jpg and file:/data/x.jpg name the same path.
		const path = src.slice(5).replace(/^\/\/(?=\/)/, "");
		try {
			return `file:${decodeURIComponent(path)}`;
		} catch {
			throw new OrbitError(
				"E_ORBIT_IMAGE_SOURCE",
				`[orbit] <img src="${src}">: not a valid file URL`,
			);
		}
	}
	if (scheme === "http")
		throw new OrbitError(
			"E_ORBIT_INSECURE_IMAGE_URL",
			`[orbit] <img src="${src}">: an image is fetched over https only`,
		);
	throw new OrbitError(
		"E_ORBIT_IMAGE_SOURCE",
		`[orbit] <img src="${src}">: ${scheme}: is not an image source (https:, file:, content:, a bundled asset or bytes)`,
	);
}

/**
 * `<img>`: an image the host decodes off the UI thread, at the size its box
 * is laid out to, and keeps in a bounded memory cache. Sized by its classes
 * (`w-*`, `h-*`, `size-*`, `aspect-*`): the box does not wait for the image
 * to learn its size. `object-*` fits it, `rounded-*` clips it, `alt` is what
 * the screen reader says.
 */
function imgElement(
	el: TElement,
	values: readonly unknown[],
	attrs: Attrs,
): NativeNode {
	const raw = new Map<string, unknown>();
	for (const attr of el.attrs) raw.set(attr.name, attrValue(attr, values));
	const node = new NativeNode("OrbitImage", {}, []);
	const style = bindClass(node, attrs, {}, (s) => s.box);
	const src = raw.get("src");
	const initial = isGetter(src) ? untrack(src) : src;
	node.props = {
		...flatten(style),
		src: imageSource(node, initial),
		alt: str(raw.get("alt")),
	};
	if (isGetter(src)) {
		let first = true;
		effect(() => {
			const next = src();
			if (first) {
				first = false;
				return;
			}
			node.setProps({ src: imageSource(node, next) });
		});
	}
	return withMotion(withEvents(node, attrs), attrs);
}

function element(
	el: TElement,
	values: readonly unknown[],
	inherited: Style,
): NativeNode {
	if (UNSUPPORTED.has(el.tag)) {
		throw new OrbitError(
			"E_ORBIT_UNSUPPORTED_ELEMENT",
			`[orbit] <${el.tag}> has no native mapping yet`,
		);
	}
	const attrs = readAttrs(el, values);
	if (el.tag === "input" || el.tag === "textarea") {
		return inputElement(el, values, inherited, attrs);
	}
	if (el.tag === "img") return imgElement(el, values, attrs);
	const own = TAG_TEXT[el.tag] ?? {};
	if (TEXT_BLOCK.has(el.tag) || INLINE.has(el.tag)) {
		const node = new NativeNode(
			"RCTText",
			{},
			textChildren(el.children, values),
		);
		const style = bindClass(node, attrs, { ...inherited, ...own }, (s) => ({
			...s.text,
			...s.box,
		}));
		node.props = flatten(style);
		return withEvents(node, attrs);
	}
	// The class is read once for inheritance; a reactive class still restyles the box.
	const classes =
		typeof attrs.className === "string"
			? attrs.className
			: untrack(attrs.className);
	if (isScrollContainer(classes))
		return scrollElement(el, values, { ...inherited, ...own }, attrs, classes);
	const initial = tw(classes);
	const flexItems = isFlexContainer(classes);
	const node = new NativeNode(
		"RCTView",
		{},
		viewChildren(
			el.children,
			values,
			{ ...inherited, ...own, ...initial.text },
			flexItems,
		),
	);
	node.props = flatten(bindClass(node, attrs, {}, (s) => s.box));
	return withMotion(withEvents(node, attrs), attrs);
}

function virtualText(el: TElement, values: readonly unknown[]): NativeNode {
	if (!INLINE.has(el.tag) && !TEXT_BLOCK.has(el.tag)) {
		throw new OrbitError(
			"E_ORBIT_BLOCK_IN_TEXT",
			`[orbit] <${el.tag}> cannot sit inside text on native`,
		);
	}
	const attrs = readAttrs(el, values);
	const node = new NativeNode(
		"RCTVirtualText",
		{},
		textChildren(el.children, values),
	);
	node.props = flatten(
		bindClass(node, attrs, TAG_TEXT[el.tag] ?? {}, (s) => ({
			...s.text,
			...s.box,
		})),
	);
	return withEvents(node, attrs);
}

// Children inside an RCTText: raw strings and nested virtual texts only.
function textChildren(nodes: TNode[], values: readonly unknown[]): Child[] {
	const out: Child[] = [];
	for (const n of nodes) {
		if (n.kind === "el") {
			out.push(virtualText(n, values));
			continue;
		}
		for (const part of n.parts) {
			if (typeof part === "string") out.push(rawText(part));
			else out.push(...textValue(values[part]));
		}
	}
	return out;
}

function textValue(v: unknown): Child[] {
	if (isGetter(v)) {
		if (isPrimitive(untrack(v))) return [rawText(() => str(v()))];
		return [region(v, textValue)];
	}
	if (isTemplateResult(v)) {
		ownLifecycle(v);
		return textChildren(parse(v.strings), v.values);
	}
	if (Array.isArray(v)) return v.flatMap(textValue);
	return isPrimitive(v) && str(v) ? [rawText(str(v))] : [];
}

// Children inside an RCTView: elements, plus text runs wrapped in RCTText.
// In a CSS flex container every child is its own flex item, inline or not;
// elsewhere inline content flows into a shared text run.
function viewChildren(
	nodes: TNode[],
	values: readonly unknown[],
	inherited: Style,
	flexItems = false,
): Child[] {
	const out: Child[] = [];
	let run: Child[] = [];
	const flushRun = () => {
		if (run.length > 0)
			out.push(new NativeNode("RCTText", flatten(inherited), run));
		run = [];
	};
	for (const n of nodes) {
		if (flexItems) flushRun();
		if (n.kind === "el") {
			if (INLINE.has(n.tag) && !flexItems) {
				run.push(virtualText(n, values));
			} else {
				flushRun();
				out.push(element(n, values, inherited));
			}
			continue;
		}
		for (const part of n.parts) {
			if (typeof part === "string") {
				run.push(rawText(part));
				continue;
			}
			const v = values[part];
			if (isPrimitive(v) || (isGetter(v) && isPrimitive(untrack(v)))) {
				run.push(...textValue(v));
			} else {
				flushRun();
				out.push(...viewValue(v, inherited));
			}
		}
	}
	flushRun();
	return out;
}

function viewValue(v: unknown, inherited: Style): Child[] {
	if (isGetter(v)) return [region(v, (value) => viewValue(value, inherited))];
	if (isTemplateResult(v)) {
		ownLifecycle(v);
		return viewChildren(parse(v.strings), v.values, inherited);
	}
	if (Array.isArray(v)) return v.flatMap((item) => viewValue(item, inherited));
	const text = str(v);
	return text
		? [new NativeNode("RCTText", flatten(inherited), [rawText(text)])]
		: [];
}

// Browser defaults for the root text context (16px, black).
const ROOT_TEXT: Style = { fontSize: 16, color: "#000000" };

/**
 * Render an aurora template as native views through the Rust host. Returns
 * the root: it commits on its own after each change (batched to a microtask);
 * `flush()` commits synchronously.
 */
export function mount(result: TemplateResult, options: MountOptions): Root {
	const tree = new NativeNode(
		"RCTView",
		flatten({ flex: 1 }),
		viewValue(result, ROOT_TEXT),
	);
	return mountTree(tree, options);
}
