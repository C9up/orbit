import { effect } from "@c9up/aurora/core";
import { colorToArgb } from "./color.js";

/**
 * The tree orbit keeps in JS: one node per native element, with the props
 * the host lays out and draws. Signals write props straight into it; a commit
 * sends only what changed (see `commit.ts`).
 */

export type Style = { [key: string]: string | number };
export type Props = { [key: string]: unknown };
export type Handler = (type: string, payload: unknown) => void;
type Value<T> = T | (() => T);

const COLOR_KEYS = new Set([
	"backgroundColor",
	"color",
	"borderColor",
	"shadowColor",
]);

// Tags the host keys its views by. Even numbers from 2^30, out of the way of
// anything else that might share a surface.
let nextTag = 1 << 30;

function allocateTag(): number {
	nextTag += 2;
	return nextTag;
}

/** Style as the host reads it: flattened, colours as ARGB integers. */
export function flatten(style: Style): Props {
	const out: Props = {};
	for (const [key, value] of Object.entries(style)) {
		out[key] =
			COLOR_KEYS.has(key) && typeof value === "string"
				? colorToArgb(value)
				: value;
	}
	return out;
}

/** Called whenever a node below `from` changed: the commit walks this path. */
let onDirty: () => void = () => {};

export function setDirtyListener(listener: () => void): void {
	onDirty = listener;
}

function markChildrenDirty(from: NativeNode | null): void {
	for (let p = from; p && !p.childrenDirty; p = p.parent)
		p.childrenDirty = true;
	onDirty();
}

/** A run of children that a reactive slot replaces wholesale. */
export class Region {
	parent: NativeNode | null = null;
	items: Child[] = [];

	set(items: Child[]): void {
		this.items = items;
		for (const item of items) adopt(item, this.parent);
		markChildrenDirty(this.parent);
	}
}

export type Child = NativeNode | Region;

function adopt(child: Child, parent: NativeNode | null): void {
	child.parent = parent;
	if (child instanceof Region)
		for (const item of child.items) adopt(item, parent);
}

function flattenInto(
	children: readonly Child[],
	out: NativeNode[],
): NativeNode[] {
	for (const child of children) {
		if (child instanceof Region) flattenInto(child.items, out);
		else out.push(child);
	}
	return out;
}

export class NativeNode {
	readonly tag = allocateTag();
	parent: NativeNode | null = null;
	/** Props changed since the last commit, or null. */
	pendingProps: Props | null = null;
	/** Something below this node changed since the last commit. */
	childrenDirty = false;
	onEvent: Handler | null = null;

	constructor(
		readonly viewName: string,
		public props: Props,
		readonly children: Child[],
	) {
		for (const child of children) adopt(child, this);
	}

	flatChildren(): NativeNode[] {
		return flattenInto(this.children, []);
	}

	setProps(patch: Props): void {
		Object.assign(this.props, patch);
		this.pendingProps = this.pendingProps
			? Object.assign(this.pendingProps, patch)
			: { ...patch };
		markChildrenDirty(this.parent);
	}
}

/** Raw text content, static or signal-backed: the effect patches only `text`. */
export function rawText(content: Value<string>): NativeNode {
	const raw = new NativeNode("RCTRawText", { text: "" }, []);
	if (typeof content === "function") {
		effect(() => raw.setProps({ text: content() }));
		// The first run is the initial content, not a change to send.
		raw.pendingProps = null;
	} else {
		raw.props.text = content;
	}
	return raw;
}
