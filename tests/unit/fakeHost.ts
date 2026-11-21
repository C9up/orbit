import type { OrbitHost } from "../../src/index.js";

export type Op = [string, number, ...unknown[]];

export interface CreatedNode {
	viewName: string;
	props: Record<string, unknown>;
	children: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOp(value: unknown): value is Op {
	return (
		Array.isArray(value) &&
		typeof value[0] === "string" &&
		typeof value[1] === "number"
	);
}

/**
 * Stands in for orbit-host: applies the ops to a plain tree, reports the
 * nodes no longer reachable from the root (as the Rust host does), and
 * records every batch and motion call.
 */
export class FakeHost implements OrbitHost {
	readonly batches: Op[][] = [];
	readonly nodes = new Map<number, CreatedNode>();
	readonly motion: Array<[string, ...unknown[]]> = [];
	/** Bytes handed to image nodes, by tag, in the order they came. */
	readonly images: Array<[number, Uint8Array]> = [];
	/** How many batches had been committed when each bytes call came. */
	readonly imagesAt: number[] = [];
	/** Each scroll view's offset (dp), as `scroll` moved it. */
	readonly offsets = new Map<number, number>();
	readonly scrolls: Array<[number, number, boolean]> = [];
	root: number | null = null;
	viewport: [number, number] = [0, 0];
	handler:
		| ((tag: number, type: string, x: number, y: number, data: string) => void)
		| null = null;

	setViewport(width: number, height: number): void {
		this.viewport = [width, height];
	}

	commit(json: string): string {
		const parsed: unknown = JSON.parse(json);
		const ops = Array.isArray(parsed) ? parsed.filter(isOp) : [];
		this.batches.push(ops);
		for (const [code, tag, a, b] of ops) {
			if (code === "c" && typeof a === "string") {
				this.nodes.set(tag, {
					viewName: a,
					props: isRecord(b) ? { ...b } : {},
					children: [],
				});
			} else if (code === "u" && isRecord(a)) {
				const node = this.nodes.get(tag);
				if (node) Object.assign(node.props, a);
			} else if (code === "k" && Array.isArray(a)) {
				const node = this.nodes.get(tag);
				if (node)
					node.children = a.filter((n): n is number => typeof n === "number");
			} else if (code === "r") {
				this.root = tag;
			}
		}
		const reachable = new Set<number>();
		const walk = (tag: number) => {
			reachable.add(tag);
			for (const child of this.nodes.get(tag)?.children ?? []) walk(child);
		};
		if (this.root !== null) walk(this.root);
		const deleted = [...this.nodes.keys()].filter((tag) => !reachable.has(tag));
		for (const tag of deleted) this.nodes.delete(tag);
		return JSON.stringify({
			deleted,
			parseUs: 0,
			layoutUs: 0,
			diffUs: 0,
			measures: 0,
			nodes: this.nodes.size,
			opsBytes: 0,
		});
	}

	imageBytes(tag: number, bytes: Uint8Array): void {
		this.images.push([tag, bytes]);
		this.imagesAt.push(this.batches.length);
	}

	/**
	 * A column layout, enough for a list: a node is as tall as its `height`
	 * prop, or its children stacked; hidden (`display: none`) takes nothing; a
	 * scroll view is as tall as the viewport unless it says otherwise.
	 */
	#height(tag: number): number {
		const node = this.nodes.get(tag);
		if (!node || node.props.display === "none") return 0;
		const own = node.props.height;
		if (typeof own === "number") return own;
		if (node.viewName === "RCTScrollView") return this.viewport[1];
		return node.children.reduce((sum, child) => sum + this.#height(child), 0);
	}

	#top(tag: number): number | null {
		if (tag === this.root) return 0;
		for (const [parentTag, parent] of this.nodes) {
			const at = parent.children.indexOf(tag);
			if (at < 0) continue;
			const parentTop = this.#top(parentTag);
			if (parentTop === null) return null;
			return parent.children
				.slice(0, at)
				.reduce((y, sibling) => y + this.#height(sibling), parentTop);
		}
		return null;
	}

	layout(tags: string): string {
		const asked: unknown = JSON.parse(tags);
		const list = Array.isArray(asked) ? asked : [];
		return JSON.stringify(
			list.map((tag) => {
				if (typeof tag !== "number" || !this.nodes.has(tag)) return null;
				const y = this.#top(tag);
				return y === null ? null : [0, y, this.viewport[0], this.#height(tag)];
			}),
		);
	}

	/** Moves the offset and reports it back, as the native view does on its next frame. */
	scroll(tag: number, by: number, toEnd: boolean): void {
		this.scrolls.push([tag, by, toEnd]);
		const content = this.nodes.get(tag)?.children[0];
		const max = Math.max(
			0,
			(content === undefined ? 0 : this.#height(content)) - this.#height(tag),
		);
		const next = toEnd
			? max
			: Math.min(max, Math.max(0, (this.offsets.get(tag) ?? 0) + by));
		this.offsets.set(tag, next);
		queueMicrotask(() => this.handler?.(tag, "topScroll", 0, next, ""));
	}

	/** The reader scrolls the view to `y`. */
	scrollTo(tag: number, y: number): void {
		this.offsets.set(tag, y);
		this.handler?.(tag, "topScroll", 0, y, "");
	}

	setEventHandler(
		handler: (
			tag: number,
			type: string,
			x: number,
			y: number,
			data: string,
		) => void,
	): void {
		this.handler = handler;
	}

	motionValue(tag: number, initial: number): void {
		this.motion.push(["value", tag, initial]);
	}
	motionInterpolate(
		tag: number,
		input: number,
		from: readonly number[],
		to: readonly number[],
	): void {
		this.motion.push(["interpolate", tag, input, [...from], [...to]]);
	}
	motionSet(tag: number, value: number): void {
		this.motion.push(["set", tag, value]);
	}
	motionStop(tag: number): void {
		this.motion.push(["stop", tag]);
	}
	motionFrames(
		tag: number,
		frames: readonly number[],
		to: number,
		loop: boolean,
	): void {
		this.motion.push(["frames", tag, frames.length, to, loop]);
	}
	motionSpring(
		tag: number,
		to: number,
		stiffness: number,
		damping: number,
		mass: number,
	): void {
		this.motion.push(["spring", tag, to, stiffness, damping, mass]);
	}
	motionDispose(tag: number): void {
		this.motion.push(["dispose", tag]);
	}
	motionBind(view: number, prop: number, node: number): void {
		this.motion.push(["bind", view, prop, node]);
	}
	motionBindScroll(scrollView: number, value: number): void {
		this.motion.push(["bindScroll", scrollView, value]);
	}

	/** The created nodes of a given kind, in creation order. */
	all(viewName: string): Array<[number, CreatedNode]> {
		return [...this.nodes.entries()].filter(([, n]) => n.viewName === viewName);
	}

	/** The text a Text node shows: its raw texts, through virtual texts. */
	text(tag: number): string {
		const node = this.nodes.get(tag);
		if (!node) return "";
		if (node.viewName === "RCTRawText") return String(node.props.text ?? "");
		return node.children.map((child) => this.text(child)).join("");
	}
}
