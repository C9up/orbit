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

import {
	batch,
	effect,
	isTemplateResult,
	memo,
	type Signal,
	signal,
	untrack,
} from "@c9up/aurora/core";
import {
	assertBindable,
	bindTemplateContext,
	type EachList,
	firstWindow,
	LazyLayout,
	type LazyList,
	type LazyView,
	readComponentLifecycle,
	readEach,
	readEachItems,
	sameWindow,
	setOwner,
	type TemplateResult,
	TemplateScanner,
} from "@c9up/aurora/renderer";
import { colorToArgb } from "./color.js";
import {
	afterCommit,
	type MountOptions,
	mountTree,
	onEveryCommit,
	type Root,
	treeHost,
} from "./commit.js";
import {
	E_ORBIT_BLOCK_IN_TEXT,
	E_ORBIT_DUPLICATE_KEY,
	E_ORBIT_IMAGE_SOURCE,
	E_ORBIT_INSECURE_IMAGE_URL,
	E_ORBIT_INVALID_SCROLL_BINDING,
	E_ORBIT_UNSUPPORTED_ELEMENT,
} from "./errors.js";
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
	type Props,
	Region,
	rawText,
	type Style,
} from "./node.js";
import { report, setErrorListener } from "./report.js";
import { Stack } from "./stack.js";
import {
	type Computed,
	computeStyle,
	type StyledElement,
	viewportSize,
} from "./styles.js";

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
const UNSUPPORTED = new Set(["select", "canvas", "iframe"]);

/**
 * Inline, as CSS lays it out: a run inside the surrounding text. An `<a>`
 * holding blocks (a card that is a link) is a block, as HTML lets it be.
 */
function isInline(n: TElement): boolean {
	if (!INLINE.has(n.tag)) return false;
	if (n.tag !== "a") return true;
	return n.children.every((child) => child.kind !== "el" || isInline(child));
}

/**
 * A link: an `<a href>`. Sitting in a view, it is a touch target of its own
 * rather than a run of the text around it — a native text's runs cannot be
 * pressed one by one — so links in a block (`<nav>`, `<li>`) each take their
 * line, as a row of them does in a `flex` parent.
 */
function isLink(n: TElement): boolean {
	return n.tag === "a" && n.attrs.some((attr) => attr.name === "href");
}

/** Where a pressed `<a href>` goes: server-driven pages set it (`@c9up/orbit/pages`). */
let followLink: ((href: string) => void) | undefined;

/** @internal Who follows a pressed link; `undefined` leaves links inert. */
export function setLinkHandler(
	handler: ((href: string) => void) | undefined,
): void {
	followLink = handler;
}

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
	n === undefined || (n.kind === "el" && !isInline(n));

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

/** Run `build` as a scope of its own: what it creates is ended by the returned disposers. */
function scoped<T>(build: () => T): [T, Array<() => void>] {
	const scope: Array<() => void> = [];
	const prevOwner = setOwner(scope);
	const prevCollecting = collecting;
	collecting = scope;
	try {
		return [build(), scope];
	} finally {
		collecting = prevCollecting;
		setOwner(prevOwner);
	}
}

/**
 * A reactive slot, read once per change, in its region only — never called
 * beforehand to see what it gives, which ran a component twice and kept the
 * first one's effects. Its first value decides where it sits: a string, a
 * number or `true` joins the text around it as one raw run, updated in place;
 * anything else is built by `other`. Nothing at first (`null`, `undefined`,
 * `false`: `${() => open() ? Panel() : null}`) is not text — what comes later
 * is most often an element, which a text run cannot hold.
 */
function reactiveSlot(
	slot: () => unknown,
	other: (value: unknown) => Child[],
): { child: Region; text: boolean } {
	const kind = { known: false, text: false };
	let raw: NativeNode | null = null;
	const child = region(slot, (value) => {
		if (!kind.known) {
			kind.known = true;
			kind.text =
				isPrimitive(value) &&
				value !== null &&
				value !== undefined &&
				value !== false;
		}
		if (!kind.text) return other(value);
		if (raw) raw.setProps({ text: str(value) });
		else raw = rawText(str(value));
		return [raw];
	});
	return { child, text: kind.text };
}

interface KeyedRow {
	item: Signal<unknown>;
	index: Signal<number>;
	region: Region;
	disposers: Array<() => void>;
}

/**
 * aurora's `each`: one row per key, as on the DOM. A row whose key stays keeps
 * its native views and its effects (it sees its new element and position
 * through its accessors, and moves if the order changed); a new key builds one
 * row; a key that left ends its row, and the host deletes its views.
 */
function keyedRegion(
	list: EachList,
	build: (value: unknown) => Child[],
	placed?: (rows: Array<[unknown, Region]>) => void,
): Region {
	if (list.lazy) return lazyRegion(list, list.lazy, build);
	const out = new Region();
	let rows = new Map<unknown, KeyedRow>();
	effect(() => {
		const items = readEachItems(list.items);
		untrack(() => {
			const next = new Map<unknown, KeyedRow>();
			items.forEach((element, position) => {
				const key = list.key(element, position);
				if (next.has(key)) {
					throw new E_ORBIT_DUPLICATE_KEY([String(key)]);
				}
				const kept = rows.get(key);
				if (kept) {
					kept.item(element);
					kept.index(position);
					next.set(key, kept);
					return;
				}
				const item = signal(element);
				const index = signal(position);
				const region = new Region();
				const [, disposers] = scoped(() =>
					region.set(build(list.run(() => list.render(item, index)))),
				);
				next.set(key, { item, index, region, disposers });
			});
			for (const [key, row] of rows) {
				if (!next.has(key)) for (const end of row.disposers.splice(0)) end();
			}
			rows = next;
			out.set([...next.values()].map((row) => row.region));
			placed?.([...next.entries()].map(([key, row]) => [key, row.region]));
		});
	});
	collecting?.push(() => {
		for (const row of rows.values())
			for (const end of row.disposers.splice(0)) end();
		rows = new Map();
	});
	return out;
}

/** The native nodes a region holds now, in order. */
function nodesOf(region: Region): NativeNode[] {
	const out: NativeNode[] = [];
	for (const item of region.items) {
		if (item instanceof Region) out.push(...nodesOf(item));
		else out.push(item);
	}
	return out;
}

type Frame = [number, number, number, number];

function isFrame(value: unknown): value is Frame {
	return (
		Array.isArray(value) &&
		value.length === 4 &&
		value.every((n) => typeof n === "number")
	);
}

/** The host's frames for `nodes` (dp, root coordinates), null where it has none. */
function framesOf(nodes: readonly NativeNode[]): Array<Frame | null> {
	const answer: unknown = JSON.parse(
		treeHost().layout(JSON.stringify(nodes.map((node) => node.tag))),
	);
	const list = Array.isArray(answer) ? answer : [];
	return nodes.map((_, i) => {
		const frame: unknown = list[i];
		return isFrame(frame) ? frame : null;
	});
}

/** A spacer's props: hidden when empty, so a gap-separated container gives it no gap. */
const spacerProps = (height: number) =>
	height > 0 ? { height, display: "flex" } : { height: 0, display: "none" };

/**
 * aurora's lazy `each` on native: only the rows intersecting the nearest
 * scroll view's viewport, plus `overscan` dp on each side, exist — as a keyed
 * list over that window, between two spacer views standing for the others at
 * their measured heights (or the estimate). The window comes from aurora's
 * own math (`LazyLayout`), as on the DOM.
 *
 * After each commit it reads its rows' frames from the host (top to next
 * top, gaps included), picks the window again on each native scroll, and when
 * a measure corrected an estimate above the viewport, scrolls the native view
 * by the difference so what was on screen stays put. `from: "end"` starts at
 * the bottom and follows new rows while the reader is there.
 */
function lazyRegion(
	list: EachList,
	lazy: LazyList,
	build: (value: unknown) => Child[],
): Region {
	const out = new Region();
	const before = new NativeNode("RCTView", spacerProps(0), []);
	const after = new NativeNode("RCTView", spacerProps(0), []);
	const layout = new LazyLayout(lazy);
	const view = signal<LazyView | null>(null);
	const measured = signal(0);
	let placed: Array<[unknown, Region]> = [];

	const keys = memo(() => {
		const all = readEachItems(list.items).map((item, index) =>
			list.key(item, index),
		);
		if (new Set(all).size !== all.length) {
			const duplicate = all.find((key, i) => all.indexOf(key) !== i);
			throw new E_ORBIT_DUPLICATE_KEY([String(duplicate)]);
		}
		return all;
	});
	const win = memo(
		() => {
			const all = keys();
			measured();
			const current = view();
			layout.keep(all);
			if (current === null) {
				const [first, last] = firstWindow(all.length, lazy);
				return layout.spacers(all, first, last);
			}
			return layout.window(all, current);
		},
		{ equals: sameWindow },
	);
	const start = memo(() => win().start);
	effect(() => {
		const w = win();
		before.setProps(spacerProps(w.before));
		after.setProps(spacerProps(w.after));
	});
	const windowList: EachList = {
		items: () => {
			const w = win();
			return readEachItems(list.items).slice(w.start, w.end);
		},
		key: (item, index) => list.key(item, index + untrack(start)),
		render: (item, index) =>
			list.render(
				item,
				memo(() => index() + start()),
			),
		run: list.run,
	};
	const rows = keyedRegion(windowList, build, (next) => {
		placed = next;
	});
	out.set([before, rows, after]);

	afterCommit(() => {
		let scroll: NativeNode | null = before.parent;
		while (scroll !== null && scroll.viewName !== "RCTScrollView")
			scroll = scroll.parent;
		const content = scroll?.flatChildren()[0];
		if (!scroll || !content) return;
		const scroller = scroll;
		let offset = 0;
		let pinned = lazy.from === "end";
		/** The row to keep in place across the next commit, and where it was. */
		let anchor: { key: unknown; top: number } | null = null;

		/** Where each shown row starts (dp, root coordinates), and where the last ends. */
		const rowTops = () => {
			const heads = placed.map(([, region]) => nodesOf(region)[0] ?? null);
			const lastRow = placed.at(-1);
			const tail = lastRow ? (nodesOf(lastRow[1]).at(-1) ?? null) : null;
			const asked = [scroller, content, before, after, tail, ...heads].filter(
				(node): node is NativeNode => node !== null,
			);
			const frames = new Map<NativeNode, Frame>();
			framesOf(asked).forEach((frame, i) => {
				const node = asked[i];
				if (frame && node) frames.set(node, frame);
			});
			const tops: Array<[unknown, number]> = [];
			placed.forEach(([key], i) => {
				const head = heads[i];
				const frame = head ? frames.get(head) : undefined;
				if (frame) tops.push([key, frame[1]]);
			});
			const afterFrame = frames.get(after);
			const tailFrame = tail ? frames.get(tail) : undefined;
			const bottom =
				after.props.display !== "none" && afterFrame
					? afterFrame[1]
					: tailFrame
						? tailFrame[1] + tailFrame[3]
						: Number.NaN;
			const beforeFrame = frames.get(before);
			const listTop =
				before.props.display !== "none" && beforeFrame
					? beforeFrame[1]
					: (tops[0]?.[1] ?? afterFrame?.[1] ?? 0);
			return {
				tops,
				bottom,
				listTop,
				port: frames.get(scroller),
				inner: frames.get(content),
			};
		};

		const refresh = () => {
			const { tops, bottom, listTop, port, inner } = rowTops();
			if (!port || !inner) return;
			let changed = false;
			tops.forEach(([key, top], i) => {
				const next = tops[i + 1]?.[1] ?? bottom;
				if (Number.isFinite(next) && layout.measure(key, next - top))
					changed = true;
			});
			// The viewport's top, in root coordinates of the unscrolled layout.
			const top = inner[1] + offset;
			const height = port[3];
			const first = tops.find(
				([, rowTop], i) =>
					(tops[i + 1]?.[1] ?? bottom) > top && rowTop <= top + height,
			);
			anchor = pinned || !first ? null : { key: first[0], top: first[1] };
			batch(() => {
				if (changed) measured((n) => n + 1);
				view(
					pinned
						? { kind: "end", height }
						: { kind: "span", from: top - listTop, to: top - listTop + height },
				);
			});
		};

		// After a commit: hold what was on screen, follow the end, measure anew.
		const stop = onEveryCommit(() => {
			const held = anchor;
			anchor = null;
			if (pinned) {
				treeHost().scroll(scroller.tag, 0, true);
			} else if (held) {
				const now = rowTops().tops.find(([key]) => Object.is(key, held.key));
				if (now && Math.abs(now[1] - held.top) > 0.5)
					treeHost().scroll(scroller.tag, now[1] - held.top, false);
			}
			refresh();
		});
		collecting?.push(stop);
		// A scroll reports every frame, and the JS thread may be busier than
		// that: each event only records the offset, and the window is picked
		// once for all of them. Refreshing per event queued them faster than
		// they were handled, and the window fell further behind the finger.
		let scheduled = false;
		const nextFrame: (run: () => void) => void =
			typeof requestAnimationFrame === "function"
				? (run) => {
						requestAnimationFrame(run);
					}
				: (run) => {
						setTimeout(run, 0);
					};
		const onScroll = (y: number) => {
			offset = y;
			if (scheduled) return;
			scheduled = true;
			nextFrame(() => {
				scheduled = false;
				if (lazy.from === "end") {
					const { port, inner } = rowTops();
					if (port && inner) pinned = offset + port[3] >= inner[3] - 2;
				}
				refresh();
			});
		};
		scroller.scrollListeners.push(onScroll);
		collecting?.push(() => {
			const at = scroller.scrollListeners.indexOf(onScroll);
			if (at >= 0) scroller.scrollListeners.splice(at, 1);
		});
		refresh();
		if (pinned) treeHost().scroll(scroller.tag, 0, true);
	});
	return out;
}

// ─── Instantiation ───────────────────────────────────────────────

/** What a gesture handler receives: the shape a DOM handler reads, plus the gesture's numbers. */
export type GestureEvent = { type: string } & { [key: string]: unknown };
type GestureHandler = (event: GestureEvent) => void;

type GestureName = "@click" | "@longpress" | "@pan" | "@swipe";

/** The gestures a template can listen to, and the flag orbit-host recognizes each by. */
const GESTURES: Record<
	GestureName,
	{ flag: number; native: string; type: string }
> = {
	"@click": { flag: 1, native: "topPress", type: "click" },
	"@longpress": { flag: 2, native: "topLongPress", type: "longpress" },
	"@pan": { flag: 4, native: "topPan", type: "pan" },
	"@swipe": { flag: 8, native: "topSwipe", type: "swipe" },
};

const isGestureName = (name: string): name is GestureName =>
	Object.hasOwn(GESTURES, name);

type Attrs = {
	className: string | (() => string);
	gestures: Map<GestureName, GestureHandler>;
	motion: MotionStyle | null;
	scrollY: MotionValue | null;
	/** The others (`data-*`, `aria-*`, `disabled`…), as written: what styles may test. */
	attributes: Map<string, unknown>;
};

function readAttrs(el: TElement, values: readonly unknown[]): Attrs {
	const attrs: Attrs = {
		className: "",
		gestures: new Map(),
		motion: null,
		scrollY: null,
		attributes: new Map(),
	};
	let href: TAttr | undefined;
	for (const attr of el.attrs) {
		if (attr.name === "href") href = attr;
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
		} else if (isGestureName(attr.name)) {
			const slot = attr.parts[0];
			const handler = typeof slot === "number" ? values[slot] : undefined;
			if (typeof handler === "function")
				attrs.gestures.set(attr.name, (event) => void handler(event));
		} else if (attr.name === "motion" || attr.name === "scroll-y") {
			const slot = attr.parts[0];
			const value = typeof slot === "number" ? values[slot] : undefined;
			if (attr.name === "motion") attrs.motion = readMotion(value);
			else if (value instanceof MotionValue) attrs.scrollY = value;
			else throw new E_ORBIT_INVALID_SCROLL_BINDING();
		} else if (attr.name.startsWith("?")) {
			// aurora's boolean attribute: present while its value is truthy.
			attrs.attributes.set(attr.name.slice(1), attrValue(attr, values));
		} else if (!attr.name.startsWith("@") && !attr.name.startsWith(".")) {
			// data-*, aria-*, disabled, role…: what the style table's variants test.
			attrs.attributes.set(attr.name, attrValue(attr, values));
		}
	}
	// A link follows its href when pressed, unless the template handles the press.
	const follow = followLink;
	if (
		el.tag === "a" &&
		href !== undefined &&
		follow !== undefined &&
		!attrs.gestures.has("@click")
	) {
		const target = href;
		attrs.gestures.set("@click", () => {
			const value = attrValue(target, values);
			const url = str(isGetter(value) ? value() : value);
			if (url !== "") follow(url);
		});
	}
	return attrs;
}

// ─── Styles ──────────────────────────────────────────────────────

/** Where an element is built: what it inherits, and who is around it. */
interface Ctx {
	/** The text style it inherits (reactive: a parent's state may change it). */
	text: () => Style;
	parent: StyledElement | null;
	/** The parent lays its children out as flex items: they shrink, as in CSS. */
	flexParent: boolean;
	/** The element built just before in the same parent (`peer-*`). */
	siblings: { last: StyledElement | null };
}

/** An attribute's value for a style condition: null when absent. */
function attributeOf(attrs: Attrs, name: string): string | null {
	const raw = attrs.attributes.get(name);
	const v = isGetter(raw) ? raw() : raw;
	if (v === null || v === undefined || v === false) return null;
	return v === true ? "" : str(v);
}

const splitClasses = (classes: string) => classes.split(/\s+/).filter(Boolean);

interface Styled {
	el: StyledElement;
	computed: () => Computed;
}

/** An element as the style table sees it, and its computed style (reactive). */
function styled(tag: string, attrs: Attrs, ctx: Ctx, root = false): Styled {
	const { className } = attrs;
	let classes: () => readonly string[];
	if (typeof className === "string") {
		const list = splitClasses(className);
		classes = () => list;
	} else {
		classes = memo(() => splitClasses(className()));
	}
	const holder: { computed: (() => Computed) | null } = { computed: null };
	const el: StyledElement = {
		tag,
		root,
		classes,
		attribute: (name) => attributeOf(attrs, name),
		parent: ctx.parent,
		previous: ctx.siblings.last,
		get vars() {
			return holder.computed?.().vars;
		},
	};
	ctx.siblings.last = el;
	const computed = memo(() => computeStyle(el, ctx.text()));
	holder.computed = computed;
	return { el, computed };
}

/** A view's box: its computed box, and CSS's flex-shrink in a flex container. */
function boxOf(c: Computed, ctx: Ctx): Style {
	return ctx.flexParent && c.box.flexShrink === undefined
		? { flexShrink: 1, ...c.box }
		: c.box;
}

/** Text props: a unitless line height (`1.5x`) becomes px against the font size. */
function textProps(style: Style): Style {
	const lh = style.lineHeight;
	if (typeof lh !== "string" || !lh.endsWith("x")) return style;
	const size = typeof style.fontSize === "number" ? style.fontSize : 16;
	return { ...style, lineHeight: Number(lh.slice(0, -1)) * size };
}

/** The children's context: what this element hands down. */
function childCtx(s: Styled, ctx: Ctx, own: Style = {}): Ctx {
	return {
		text: memo(() => ({ ...ctx.text(), ...own, ...s.computed().text })),
		parent: s.el,
		flexParent: untrack(s.computed).flex,
		siblings: { last: null },
	};
}

/** Keep `node`'s style props equal to `compute()`, patching what changed; returns the first. */
function bindStyle(node: NativeNode, compute: () => Style): Style {
	let previous: Props = {};
	let initial: Style = {};
	let first = true;
	effect(() => {
		const next = compute();
		const flat = flatten(next);
		if (first) {
			initial = next;
			first = false;
		} else {
			const patch: Props = {};
			for (const [key, value] of Object.entries(flat))
				if (previous[key] !== value) patch[key] = value;
			for (const key of Object.keys(previous))
				if (!(key in flat)) patch[key] = null;
			if (Object.keys(patch).length > 0) node.setProps(patch);
		}
		previous = flat;
	});
	return initial;
}

/** A text node holding a run, styled by what it inherits. */
function textRun(ctx: Ctx, run: Child[]): NativeNode {
	const node = new NativeNode("RCTText", {}, run);
	node.props = flatten(bindStyle(node, () => textProps(ctx.text())));
	return node;
}

// ─── Gestures ────────────────────────────────────────────────────

function gestureData(payload: unknown): { [key: string]: unknown } {
	const text: unknown =
		typeof payload === "object" && payload !== null
			? Reflect.get(payload, "text")
			: undefined;
	if (typeof text !== "string" || text === "") return {};
	try {
		const data: unknown = JSON.parse(text);
		return typeof data === "object" && data !== null && !Array.isArray(data)
			? Object.fromEntries(Object.entries(data))
			: {};
	} catch {
		return {};
	}
}

/**
 * `@click`, `@longpress`, `@pan` and `@swipe`, recognized natively: the node
 * tells orbit-host which it listens to (`gestures`, a set of flags), the host
 * recognizes them on the UI thread — the press feedback starts there, even
 * with this thread busy — and delivers the outcome here. A click fires on
 * release if the finger stayed put and nothing took the touch over (a scroll
 * view, a long press); a pan reports `phase`, `dx`, `dy`, `vx`, `vy` (dp,
 * dp/s); a swipe is a pan that ended fast, with its `direction`.
 */
function withEvents(node: NativeNode, attrs: Attrs): NativeNode {
	const { gestures } = attrs;
	if (gestures.size === 0) return node;
	let flags = 0;
	const byNative = new Map<string, [string, GestureHandler]>();
	for (const [name, handler] of gestures) {
		const gesture = GESTURES[name];
		flags |= gesture.flag;
		byNative.set(gesture.native, [gesture.type, handler]);
	}
	node.props.gestures = flags;
	node.onEvent = (type, payload) => {
		const entry = byNative.get(type);
		if (!entry) return;
		const [eventType, handler] = entry;
		handler({ ...gestureData(payload), type: eventType });
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
	ctx: Ctx,
	attrs: Attrs,
	s: Styled,
): NativeNode {
	const split = (c: Computed) => {
		const outer: Style = {};
		const content: Style = {};
		for (const [key, value] of Object.entries(boxOf(c, ctx)))
			(CONTENT_KEYS.has(key) ? content : outer)[key] = value;
		if (c.flex && content.flexDirection === undefined)
			content.flexDirection = "row";
		return { outer, content };
	};
	const container = new NativeNode(
		"RCTView",
		{},
		viewChildren(
			el.children,
			values,
			childCtx(s, ctx),
			untrack(s.computed).flex,
		),
	);
	container.props = flatten(
		bindStyle(container, () => split(s.computed()).content),
	);
	const node = new NativeNode("RCTScrollView", {}, [container]);
	node.props = flatten(bindStyle(node, () => split(s.computed()).outer));
	const { scrollY } = attrs;
	if (scrollY) afterCommit(() => bindScrollY(node.tag, scrollY));
	return withMotion(node, attrs);
}

// On the web a scrolling element's padding, gap and flow lay out its content;
// on native those belong to the scroll view's content container.
const CONTENT_KEYS = new Set([
	"padding",
	"paddingHorizontal",
	"paddingVertical",
	"paddingTop",
	"paddingBottom",
	"paddingLeft",
	"paddingRight",
	"gap",
	"rowGap",
	"columnGap",
	"flexDirection",
	"flexWrap",
	"alignItems",
	"justifyContent",
]);

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
	ctx: Ctx,
	attrs: Attrs,
	s: Styled,
): NativeNode {
	const raw = new Map<string, unknown>();
	for (const attr of el.attrs) raw.set(attr.name, attrValue(attr, values));
	const type = str(raw.get("type") ?? "text").toLowerCase();
	const multiline = el.tag === "textarea";
	const rowsAttr = Number(str(raw.get("rows")));
	const maxLength = Number(str(raw.get("maxlength")));
	const inputmode = str(raw.get("inputmode")).toLowerCase();
	const node = new NativeNode("OrbitTextInput", {}, []);
	const style = bindStyle(node, () => {
		const c = s.computed();
		return textProps({
			placeholderColor: c.placeholder ?? PLACEHOLDER,
			...ctx.text(),
			...c.text,
			...boxOf(c, ctx),
		});
	});
	const bound = raw.get(".value") ?? raw.get("value");
	let lastNative = isGetter(bound) ? str(untrack(bound)) : str(bound);
	let version = 0;
	node.props = {
		...flatten(style),
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

/** An address as an error quotes it: a `data:` URL can be megabytes long. */
function quoted(src: string): string {
	return src.length > 80 ? `${src.slice(0, 80)}…` : src;
}

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
		// `//host/a.png` borrows a page's scheme in a browser; an app has no page.
		if (src.startsWith("//")) {
			throw new E_ORBIT_IMAGE_SOURCE([
				quoted(src),
				"a scheme-relative address names no scheme: write https://",
			]);
		}
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
			throw new E_ORBIT_IMAGE_SOURCE([quoted(src), "not a valid file URL"]);
		}
	}
	if (scheme === "http") throw new E_ORBIT_INSECURE_IMAGE_URL([quoted(src)]);
	throw new E_ORBIT_IMAGE_SOURCE([
		quoted(src),
		`${scheme}: is not an image source (https:, file:, content:, a bundled asset or bytes)`,
	]);
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
	s: Styled,
	ctx: Ctx,
): NativeNode {
	const raw = new Map<string, unknown>();
	for (const attr of el.attrs) raw.set(attr.name, attrValue(attr, values));
	const node = new NativeNode("OrbitImage", {}, []);
	const style = bindStyle(node, () => boxOf(s.computed(), ctx));
	const src = raw.get("src");
	// An address written in the template is the developer's: a refusal throws.
	// One that comes from data (a slot) is the content's: that image shows
	// nothing and the refusal goes to `mount`'s `onError`, as a browser shows a
	// broken image and draws the rest of the page.
	const fromData =
		el.attrs
			.find((attr) => attr.name === "src")
			?.parts.some((part) => typeof part === "number") ?? false;
	const source = (value: unknown): string => {
		if (!fromData) return imageSource(node, value);
		try {
			return imageSource(node, value);
		} catch (error) {
			if (
				error instanceof E_ORBIT_INSECURE_IMAGE_URL ||
				error instanceof E_ORBIT_IMAGE_SOURCE
			) {
				report(error);
				return "";
			}
			throw error;
		}
	};
	const initial = isGetter(src) ? untrack(src) : src;
	node.props = {
		...flatten(style),
		src: source(initial),
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
			node.setProps({ src: source(next) });
		});
	}
	return withMotion(withEvents(node, attrs), attrs);
}

// ─── SVG ─────────────────────────────────────────────────────────

/** What orbit-host draws (`crates/orbit-host/src/vector.rs`); anything else is refused. */
const SVG_TAGS = new Set([
	"svg",
	"g",
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"title",
	"desc",
	"metadata",
]);

/** The attributes the host reads; the rest (xmlns, aria-*, class) stay here. */
const SVG_ATTRS = new Set([
	"viewBox",
	"preserveAspectRatio",
	"width",
	"height",
	"fill",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"fill-rule",
	"fill-opacity",
	"stroke-opacity",
	"opacity",
	"shape-rendering",
	"transform",
	"d",
	"x",
	"y",
	"rx",
	"ry",
	"cx",
	"cy",
	"r",
	"x1",
	"y1",
	"x2",
	"y2",
	"points",
]);

type SvgNode = {
	t: string;
	a: { [name: string]: string | number };
	c: SvgNode[];
};

/** A paint attribute as the host reads it: ARGB, or `none` / `currentColor`. */
function svgPaint(value: string): string | number {
	const v = value.trim();
	if (v === "none" || v === "currentColor") return v;
	return colorToArgb(v);
}

/** An svg element and what it holds, read now (inside the drawing's effect). */
function svgTree(el: TElement, values: readonly unknown[]): SvgNode {
	if (!SVG_TAGS.has(el.tag)) {
		throw new E_ORBIT_UNSUPPORTED_ELEMENT([
			el.tag,
			"inside <svg> is not drawn: paths, basic shapes and g are",
		]);
	}
	const a: SvgNode["a"] = {};
	for (const attr of el.attrs) {
		if (!SVG_ATTRS.has(attr.name)) continue;
		const raw = attrValue(attr, values);
		const value = isGetter(raw) ? raw() : raw;
		if (value === null || value === undefined || value === false) continue;
		const text = str(value);
		a[attr.name] =
			attr.name === "fill" || attr.name === "stroke" ? svgPaint(text) : text;
	}
	return { t: el.tag, a, c: svgChildren(el.children, values) };
}

/** Child elements, through the slots between them (`${body}`, lists, getters). */
function svgChildren(nodes: TNode[], values: readonly unknown[]): SvgNode[] {
	const out: SvgNode[] = [];
	const visit = (v: unknown): void => {
		if (isGetter(v)) visit(v());
		else if (Array.isArray(v)) v.forEach(visit);
		else if (isTemplateResult(v))
			out.push(...svgChildren(parse(v.strings), slotValues(v)));
	};
	for (const n of nodes) {
		if (n.kind === "el") out.push(svgTree(n, values));
		else
			for (const part of n.parts)
				if (typeof part === "number") visit(values[part]);
	}
	return out;
}

/** A length attribute in px (`24`, `24px`), or undefined for anything else (`100%`). */
function svgLength(el: TElement, name: string, values: readonly unknown[]) {
	const attr = el.attrs.find((a) => a.name === name);
	if (!attr) return undefined;
	const raw = attrValue(attr, values);
	const n = Number(str(isGetter(raw) ? untrack(raw) : raw).replace(/px$/, ""));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * `<svg>`: a vector view orbit-host draws from its paths. The class gives its
 * box and its text colour (what `currentColor` paints with, else the colour
 * it inherits); `width` / `height` size it when the class does not, and the
 * viewBox keeps its proportions.
 */
function svgElement(
	el: TElement,
	values: readonly unknown[],
	ctx: Ctx,
	attrs: Attrs,
	s: Styled,
): NativeNode {
	const node = new NativeNode("OrbitVector", {}, []);
	const box = bindStyle(node, () => boxOf(s.computed(), ctx));
	const sized: Style = {};
	const width = svgLength(el, "width", values);
	const height = svgLength(el, "height", values);
	if (width !== undefined && box.width === undefined) sized.width = width;
	if (height !== undefined && box.height === undefined) sized.height = height;
	const viewBox = el.attrs.find((a) => a.name === "viewBox");
	const numbers = viewBox
		? str(attrValue(viewBox, values))
				.trim()
				.split(/[\s,]+/)
				.map(Number)
		: [];
	const [, , vw, vh] = numbers;
	if (
		vw !== undefined &&
		vh !== undefined &&
		vw > 0 &&
		vh > 0 &&
		box.aspectRatio === undefined &&
		(sized.width === undefined || sized.height === undefined)
	) {
		sized.aspectRatio = vw / vh;
	}
	const color = (): string => {
		const value = s.computed().text.color ?? ctx.text().color ?? "#000000";
		return typeof value === "string" ? value : "#000000";
	};
	const describe = () => ({
		color: colorToArgb(color()),
		root: svgTree(el, values),
	});
	let first = true;
	let initial: ReturnType<typeof describe> | null = null;
	effect(() => {
		const next = describe();
		if (first) {
			first = false;
			initial = next;
		} else {
			node.setProps({ vector: next });
		}
	});
	node.props = { ...flatten({ ...sized, ...box }), vector: initial };
	return withMotion(withEvents(node, attrs), attrs);
}

function element(
	el: TElement,
	values: readonly unknown[],
	ctx: Ctx,
): NativeNode {
	if (UNSUPPORTED.has(el.tag)) {
		throw new E_ORBIT_UNSUPPORTED_ELEMENT([
			el.tag,
			"has no native mapping yet",
		]);
	}
	const attrs = readAttrs(el, values);
	const s = styled(el.tag, attrs, ctx);
	if (el.tag === "input" || el.tag === "textarea") {
		return inputElement(el, values, ctx, attrs, s);
	}
	if (el.tag === "img") return imgElement(el, values, attrs, s, ctx);
	if (el.tag === "svg") return svgElement(el, values, ctx, attrs, s);
	const own = TAG_TEXT[el.tag] ?? {};
	if (TEXT_BLOCK.has(el.tag) || isInline(el)) {
		const node = new NativeNode(
			"RCTText",
			{},
			textChildren(el.children, values, childCtx(s, ctx, own)),
		);
		node.props = flatten(
			bindStyle(node, () => {
				const c = s.computed();
				return textProps({
					...ctx.text(),
					...own,
					...c.text,
					...boxOf(c, ctx),
				});
			}),
		);
		return withEvents(node, attrs);
	}
	// What the element is (a scroll view, a flex container) is read once.
	const first = untrack(s.computed);
	if (first.scroll) return scrollElement(el, values, ctx, attrs, s);
	const node = new NativeNode(
		"RCTView",
		{},
		viewChildren(el.children, values, childCtx(s, ctx, own), first.flex),
	);
	node.props = flatten(bindStyle(node, () => boxOf(s.computed(), ctx)));
	return withMotion(withEvents(node, attrs), attrs);
}

function virtualText(
	el: TElement,
	values: readonly unknown[],
	ctx: Ctx,
): NativeNode {
	if (!isInline(el) && !TEXT_BLOCK.has(el.tag)) {
		throw new E_ORBIT_BLOCK_IN_TEXT([el.tag]);
	}
	const attrs = readAttrs(el, values);
	const s = styled(el.tag, attrs, ctx);
	const own = TAG_TEXT[el.tag] ?? {};
	const node = new NativeNode(
		"RCTVirtualText",
		{},
		textChildren(el.children, values, childCtx(s, ctx, own)),
	);
	// Only its own style: the host cascades the rest from the text around it.
	node.props = flatten(
		bindStyle(node, () => {
			const c = s.computed();
			const mine = { ...own, ...c.text, ...c.box };
			const size = mine.fontSize ?? ctx.text().fontSize;
			const lh = textProps({
				fontSize: size ?? 16,
				lineHeight: mine.lineHeight ?? "",
			});
			return mine.lineHeight === undefined
				? mine
				: { ...mine, lineHeight: lh.lineHeight ?? "" };
		}),
	);
	return withEvents(node, attrs);
}

// Children inside an RCTText: raw strings and nested virtual texts only.
function textChildren(
	nodes: TNode[],
	values: readonly unknown[],
	ctx: Ctx,
): Child[] {
	const out: Child[] = [];
	for (const n of nodes) {
		if (n.kind === "el") {
			out.push(virtualText(n, values, ctx));
			continue;
		}
		for (const part of n.parts) {
			if (typeof part === "string") out.push(rawText(part));
			else out.push(...textValue(values[part], ctx));
		}
	}
	return out;
}

function textValue(v: unknown, ctx: Ctx): Child[] {
	const list = readEach(v);
	const again = (value: unknown) => textValue(value, ctx);
	if (list) return [keyedRegion(list, again)];
	if (isGetter(v)) return [reactiveSlot(v, again).child];
	if (isTemplateResult(v)) {
		ownLifecycle(v);
		return textChildren(parse(v.strings), slotValues(v), ctx);
	}
	if (Array.isArray(v)) return v.flatMap(again);
	return isPrimitive(v) && str(v) ? [rawText(str(v))] : [];
}

// Children inside an RCTView: elements, plus text runs wrapped in RCTText.
// In a CSS flex container every child is its own flex item, inline or not;
// elsewhere inline content flows into a shared text run.
function viewChildren(
	nodes: TNode[],
	values: readonly unknown[],
	ctx: Ctx,
	flexItems = false,
): Child[] {
	const out: Child[] = [];
	let run: Child[] = [];
	const flushRun = () => {
		// A run of nothing but white space makes no box, as in CSS: the
		// spaces between `${…}` in a template are not flex items.
		const blank = run.every(
			(c) =>
				c instanceof NativeNode &&
				c.viewName === "RCTRawText" &&
				!/\S/.test(str(c.props.text)),
		);
		if (run.length > 0 && !blank) out.push(textRun(ctx, run));
		run = [];
	};
	for (const n of nodes) {
		if (flexItems) flushRun();
		if (n.kind === "el") {
			if (isInline(n) && !flexItems && !isLink(n)) {
				run.push(virtualText(n, values, ctx));
			} else {
				flushRun();
				out.push(element(n, values, ctx));
			}
			continue;
		}
		for (const part of n.parts) {
			if (typeof part === "string") {
				run.push(rawText(part));
				continue;
			}
			const v = values[part];
			if (isPrimitive(v)) {
				run.push(...textValue(v, ctx));
			} else if (isGetter(v) && !readEach(v)) {
				const slot = reactiveSlot(v, (value) => viewValue(value, ctx));
				if (slot.text) {
					run.push(slot.child);
				} else {
					flushRun();
					out.push(slot.child);
				}
			} else {
				flushRun();
				out.push(...viewValue(v, ctx));
			}
		}
	}
	flushRun();
	return out;
}

function viewValue(v: unknown, ctx: Ctx): Child[] {
	if (v instanceof Stack) {
		return [
			v.attach(
				(result) => scoped(() => viewValue(result, ctx)),
				(end) => collecting?.push(end),
			),
		];
	}
	const list = readEach(v);
	const again = (value: unknown) => viewValue(value, ctx);
	if (list) return [keyedRegion(list, again)];
	if (isGetter(v)) return [region(v, again)];
	if (isTemplateResult(v)) {
		ownLifecycle(v);
		return viewChildren(parse(v.strings), slotValues(v), ctx, ctx.flexParent);
	}
	if (Array.isArray(v)) return v.flatMap(again);
	const text = str(v);
	return text ? [textRun(ctx, [rawText(text)])] : [];
}

/**
 * A template's values, each function bound to the providers the template was
 * written under: a component a slot builds later (a row, a branch, a pushed
 * screen's child) still injects what was provided around it.
 */
function slotValues(result: TemplateResult): unknown[] {
	return result.values.map((value) => bindTemplateContext(result, value));
}

// The root text: a browser's 16px black, and Tailwind's preflight line height
// (`html { line-height: 1.5 }`), a multiple each text applies to its own size.
const ROOT_TEXT: Style = { fontSize: 16, color: "#000000", lineHeight: "1.5x" };

/**
 * Render an aurora template as native views through the Rust host. Returns
 * the root: it commits on its own after each change (batched to a microtask);
 * `flush()` commits synchronously.
 */
export function mount(result: TemplateResult, options: MountOptions): Root {
	setErrorListener(options.onError ?? null);
	viewportSize(options.viewport);
	const top: Ctx = {
		text: () => ROOT_TEXT,
		parent: null,
		flexParent: false,
		siblings: { last: null },
	};
	// The root is the page's html and body: the base layer's `body { … }`
	// (nebula's background and text colour) styles it.
	const body = styled(
		"body",
		{
			className: "",
			gestures: new Map(),
			motion: null,
			scrollY: null,
			attributes: new Map(),
		},
		top,
		true,
	);
	const tree = new NativeNode(
		"RCTView",
		{},
		viewValue(result, childCtx(body, top)),
	);
	tree.props = flatten(
		bindStyle(tree, () => ({ flex: 1, ...boxOf(body.computed(), top) })),
	);
	return mountTree(tree, options);
}
