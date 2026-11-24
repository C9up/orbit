import {
	E_ORBIT_COMMIT_FAILED,
	E_ORBIT_SVG_VALUE,
	E_ORBIT_TREE_TOO_DEEP,
} from "./errors.js";
import { currentHost, type OrbitHost } from "./host.js";
import { type NativeNode, type Props, setDirtyListener } from "./node.js";
import { type ErrorListener, report } from "./report.js";
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
	/** What the host left out of the drawings of this commit, coded (`E_ORBIT_SVG_VALUE: …`). */
	warnings?: string[];
}

function isReport(value: unknown): value is OrbitReport {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray(Reflect.get(value, "deleted"))
	);
}

/** The codes the host prefixes its messages with, as the errors orbit throws. */
const HOST_CODES = {
	E_ORBIT_TREE_TOO_DEEP,
	E_ORBIT_SVG_VALUE,
} as const;

/** A coded host message (`E_ORBIT_X: what happened`) as orbit's error for it. */
function hostError(message: string, cause?: unknown): Error | null {
	const at = message.indexOf(": ");
	const code = at < 0 ? "" : message.slice(0, at);
	for (const [name, ErrorClass] of Object.entries(HOST_CODES)) {
		if (name === code)
			return new ErrorClass([message.slice(at + 2)], { cause });
	}
	return null;
}

/**
 * Why the host refused a commit: its `{ "error": … }` report, thrown by the
 * native module as the message of a JS error (or returned, by a host that
 * does not throw).
 */
function refusal(answer: unknown, cause?: unknown): Error {
	let detail = answer;
	if (typeof answer === "string") {
		try {
			detail = JSON.parse(answer);
		} catch {
			detail = answer;
		}
	}
	const message =
		typeof detail === "object" && detail !== null
			? Reflect.get(detail, "error")
			: undefined;
	if (typeof message === "string") {
		const coded = hostError(message, cause);
		if (coded) return coded;
	}
	return new E_ORBIT_COMMIT_FAILED([detail], { cause });
}

/**
 * `text` with every unpaired surrogate replaced by U+FFFD, as
 * `String.prototype.toWellFormed` does (Hermes has none). Half an emoji is
 * ordinary content — `"Ana😀".slice(0, 4)` — and a browser shows it as U+FFFD.
 */
export function toWellFormed(text: string): string {
	let out = "";
	let from = 0;
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0xd800 || unit > 0xdfff) continue;
		if (unit <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i += 1;
				continue;
			}
		}
		out += `${text.slice(from, i)}\ufffd`;
		from = i + 1;
	}
	return from === 0 ? text : out + text.slice(from);
}

const wellFormed = (_key: string, value: unknown): unknown =>
	typeof value === "string" ? toWellFormed(value) : value;

/**
 * The batch as JSON the host reads. `JSON.stringify` writes an unpaired
 * surrogate as a `\ud…` escape (lower-case, per ECMA-262 and Hermes), which
 * the host's strict JSON reader refuses: one cut emoji would fail the whole
 * commit. Only a batch holding such an escape pays for the second pass.
 */
export function serialise(ops: readonly unknown[]): string {
	const json = JSON.stringify(ops);
	return json.includes("\\ud") ? JSON.stringify(ops, wellFormed) : json;
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

/**
 * What a commit settled in the JS tree before the host answered, so that a
 * batch the host refuses is sent again rather than taken for applied.
 */
interface Sent {
	/** Nodes this batch created. */
	created: NativeNode[];
	/** Patches this batch carried, by node. */
	patched: Array<[NativeNode, Props]>;
	/** Existing nodes whose children this batch walked. */
	walked: NativeNode[];
}

function visit(
	node: NativeNode,
	ops: unknown[],
	bytes: Bytes,
	sent: Sent,
): void {
	takeBytes(node, bytes);
	if (!created.has(node)) {
		ops.push(["c", node.tag, node.viewName, node.props]);
		created.add(node);
		byTag.set(node.tag, node);
		sent.created.push(node);
		node.pendingProps = null;
		const kids = node.flatChildren();
		for (const kid of kids) visit(kid, ops, bytes, sent);
		const tags = kids.map((kid) => kid.tag);
		if (tags.length > 0) ops.push(["k", node.tag, tags]);
		lastChildren.set(node, tags);
		node.childrenDirty = false;
		return;
	}
	if (node.pendingProps) {
		ops.push(["u", node.tag, node.pendingProps]);
		sent.patched.push([node, node.pendingProps]);
		node.pendingProps = null;
	}
	if (node.childrenDirty) {
		sent.walked.push(node);
		const kids = node.flatChildren();
		for (const kid of kids) visit(kid, ops, bytes, sent);
		const tags = kids.map((kid) => kid.tag);
		if (!sameTags(lastChildren.get(node), tags)) {
			ops.push(["k", node.tag, tags]);
			lastChildren.set(node, tags);
		}
		node.childrenDirty = false;
	}
}

/**
 * The host refused the batch: nothing it carried counts as applied. Created
 * nodes are created again, patches sent again, and every children list the
 * batch walked is sent again whole — the host may have applied part of the
 * batch before it refused, so a list it holds is not known any more.
 */
function unsend(sent: Sent): void {
	for (const node of sent.created) {
		created.delete(node);
		byTag.delete(node.tag);
		lastChildren.delete(node);
		node.childrenDirty = true;
	}
	for (const [node, patch] of sent.patched) {
		node.pendingProps = node.pendingProps
			? Object.assign(patch, node.pendingProps)
			: patch;
	}
	for (const node of sent.walked) {
		lastChildren.delete(node);
		node.childrenDirty = true;
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
			if (this.#scheduled) this.commitOrReport();
		});
	}

	/** Commit what changed now, instead of at the end of the turn. */
	flush(): OrbitReport {
		return this.commit();
	}

	/**
	 * A commit nobody waits on (scheduled, or after the window resized): a
	 * refusal goes to `mount`'s `onError` instead of out of a microtask or a
	 * native event. What the batch carried is sent again with the next commit.
	 */
	commitOrReport(): void {
		try {
			this.commit();
		} catch (error) {
			report(
				error instanceof Error
					? error
					: new E_ORBIT_COMMIT_FAILED([String(error)]),
			);
		}
	}

	commit(): OrbitReport {
		this.#scheduled = false;
		const ops: unknown[] = [];
		const bytes: Bytes = [];
		const sent: Sent = { created: [], patched: [], walked: [] };
		visit(this.#tree, ops, bytes, sent);
		const rootSent = this.#rootSent;
		if (!rootSent) ops.push(["r", this.#tree.tag]);
		// Before the ops that show them: the host reads them when it mounts.
		// Bytes stay with the host once handed over, refused batch or not.
		for (const [tag, data] of bytes) this.#host.imageBytes(tag, data);
		let answer: unknown;
		try {
			answer = JSON.parse(this.#host.commit(serialise(ops)));
		} catch (error) {
			unsend(sent);
			throw refusal(error instanceof Error ? error.message : error, error);
		}
		if (!isReport(answer)) {
			unsend(sent);
			throw refusal(answer);
		}
		this.#rootSent = true;
		for (const tag of answer.deleted) {
			const node = byTag.get(tag);
			if (!node) continue;
			byTag.delete(tag);
			created.delete(node);
			lastChildren.delete(node);
		}
		for (const warning of answer.warnings ?? []) {
			report(hostError(warning) ?? new E_ORBIT_SVG_VALUE([warning]));
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
	/**
	 * Told of what orbit recovered from instead of throwing: a scheduled
	 * commit the host refused (`E_ORBIT_COMMIT_FAILED`, `E_ORBIT_TREE_TOO_DEEP`;
	 * the batch is sent again with the next commit), an image address from data
	 * orbit will not load (`E_ORBIT_INSECURE_IMAGE_URL`, `E_ORBIT_IMAGE_SOURCE`;
	 * that image shows nothing), a value of a drawing the host left out
	 * (`E_ORBIT_SVG_VALUE`). Default: `console.warn` in a development build
	 * (`__DEV__`), nothing in production.
	 */
	onError?: ErrorListener;
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
			root.commitOrReport();
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
