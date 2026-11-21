import { OrbitError } from "./errors.js";
import { currentHost, type OrbitHost } from "./host.js";
import { type NativeNode, setDirtyListener } from "./node.js";
import { viewportSize } from "./styles.js";

/**
 * Committing the JS tree to the Rust host: one JSON batch per commit over JSI
 * (create, props patch, children, root). Layout, diffing and mounting happen in
 * Rust and on the platform side. Commits are batched to a microtask, so many
 * signal writes in one turn cost one commit.
 */

export interface OrbitReport {
	deleted: number[];
	parseUs: number;
	layoutUs: number;
	diffUs: number;
	measures: number;
	nodes: number;
	opsBytes: number;
}

function isReport(value: unknown): value is OrbitReport {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray(Reflect.get(value, "deleted"))
	);
}

const created = new WeakSet<NativeNode>();
const byTag = new Map<number, NativeNode>();
const lastChildren = new WeakMap<NativeNode, number[]>();
const afterCommitHooks: Array<() => void> = [];
const commitListeners = new Set<() => void>();
let mountedHost: OrbitHost | null = null;

/** Run `listener` after every commit; returns what stops it. */
export function onEveryCommit(listener: () => void): () => void {
	commitListeners.add(listener);
	return () => commitListeners.delete(listener);
}

/** The host the mounted tree commits to (layout reads, scrolling). */
export function treeHost(): OrbitHost {
	return mountedHost ?? currentHost();
}

/** Run `hook` once the next commit has reached the host (aurora's onMount timing). */
export function afterCommit(hook: () => void): void {
	afterCommitHooks.push(hook);
}

function sameTags(
	a: readonly number[] | undefined,
	b: readonly number[],
): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

type Bytes = Array<[number, Uint8Array]>;

// Only nodes the commit reaches hand their bytes over: the host drops them
// with the node, so bytes of a node it never saw would stay behind.
function takeBytes(node: NativeNode, bytes: Bytes): void {
	if (node.pendingBytes) {
		bytes.push([node.tag, node.pendingBytes]);
		node.pendingBytes = null;
	}
}

function visit(node: NativeNode, ops: unknown[], bytes: Bytes): void {
	takeBytes(node, bytes);
	if (!created.has(node)) {
		ops.push(["c", node.tag, node.viewName, node.props]);
		created.add(node);
		byTag.set(node.tag, node);
		node.pendingProps = null;
		const kids = node.flatChildren();
		for (const kid of kids) visit(kid, ops, bytes);
		const tags = kids.map((kid) => kid.tag);
		if (tags.length > 0) ops.push(["k", node.tag, tags]);
		lastChildren.set(node, tags);
		node.childrenDirty = false;
		return;
	}
	if (node.pendingProps) {
		ops.push(["u", node.tag, node.pendingProps]);
		node.pendingProps = null;
	}
	if (node.childrenDirty) {
		const kids = node.flatChildren();
		for (const kid of kids) visit(kid, ops, bytes);
		const tags = kids.map((kid) => kid.tag);
		if (!sameTags(lastChildren.get(node), tags)) {
			ops.push(["k", node.tag, tags]);
			lastChildren.set(node, tags);
		}
		node.childrenDirty = false;
	}
}

export class Root {
	readonly #host: OrbitHost;
	readonly #tree: NativeNode;
	#scheduled = false;
	#rootSent = false;
	/** Every commit's report, newest last (development and benchmarks). */
	readonly reports: OrbitReport[] = [];

	constructor(host: OrbitHost, tree: NativeNode) {
		this.#host = host;
		this.#tree = tree;
	}

	schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		void Promise.resolve().then(() => {
			// A synchronous flush() may already have committed this batch.
			if (this.#scheduled) this.commit();
		});
	}

	/** Commit what changed now, instead of at the end of the turn. */
	flush(): OrbitReport {
		return this.commit();
	}

	commit(): OrbitReport {
		this.#scheduled = false;
		const ops: unknown[] = [];
		const bytes: Bytes = [];
		visit(this.#tree, ops, bytes);
		if (!this.#rootSent) {
			ops.push(["r", this.#tree.tag]);
			this.#rootSent = true;
		}
		// Before the ops that show them: the host reads them when it mounts.
		for (const [tag, data] of bytes) this.#host.imageBytes(tag, data);
		const answer: unknown = JSON.parse(this.#host.commit(JSON.stringify(ops)));
		if (!isReport(answer)) {
			throw new OrbitError(
				"E_ORBIT_COMMIT_FAILED",
				`[orbit] the host refused a commit: ${JSON.stringify(answer)}`,
			);
		}
		for (const tag of answer.deleted) {
			const node = byTag.get(tag);
			if (!node) continue;
			byTag.delete(tag);
			created.delete(node);
			lastChildren.delete(node);
		}
		this.reports.push(answer);
		for (const hook of afterCommitHooks.splice(0)) hook();
		for (const listener of [...commitListeners]) listener();
		return answer;
	}
}

export interface MountOptions {
	/** The root's size in dp (React Native: `Dimensions.get("window")`). */
	viewport: { width: number; height: number };
	/** Defaults to the host given to `useHost`. */
	host?: OrbitHost;
}

/** Mount a native tree; returns its root (`flush()` commits synchronously). */
export function mountTree(tree: NativeNode, options: MountOptions): Root {
	const host = options.host ?? currentHost();
	const root = new Root(host, tree);
	mountedHost = host;
	setDirtyListener(() => root.schedule());
	host.setViewport(options.viewport.width, options.viewport.height);
	host.setEventHandler((tag, type, x, y, data) => {
		if (type === "topScroll") {
			for (const listener of byTag.get(tag)?.scrollListeners ?? []) listener(y);
			return;
		}
		if (type === "topViewport") {
			// The window resized (the keyboard came or went): lay out again.
			host.setViewport(x, y);
			viewportSize({ width: x, height: y });
			root.commit();
			return;
		}
		const payload = {
			pageX: x,
			pageY: y,
			locationX: x,
			locationY: y,
			text: data,
		};
		for (let node = byTag.get(tag) ?? null; node; node = node.parent) {
			if (node.onEvent) {
				node.onEvent(type, payload);
				return;
			}
		}
	});
	root.commit();
	return root;
}
