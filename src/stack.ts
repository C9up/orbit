import {
	component,
	createContext,
	inject,
	provide,
	type Signal,
	signal,
	untrack,
} from "@c9up/aurora/core";
import { captureContext, type TemplateResult } from "@c9up/aurora/renderer";
import { afterCommit, treeHost } from "./commit.js";
import { OrbitError } from "./errors.js";
import { bindMotion, MotionValue } from "./motion.js";
import { type Child, flatten, NativeNode, Region } from "./node.js";

/**
 * Navigation between screens: a stack of aurora components, the top one
 * shown. A covered screen stays built — its views laid out under the top one,
 * its state and its effects kept — and is hidden once covered; a popped one
 * ends. Transitions are motion values, played by the host on the UI thread.
 *
 *     const stack = createStack(Home);
 *     return html`${stack}`;
 *
 *     // in any screen
 *     const screen = useScreen();
 *     screen.push(Detail, { id: 3 });
 *
 * Nothing here knows URLs: a router or server-driven pages push the screen a
 * URL names on top of it.
 */

/** A screen: an aurora component (or any function returning a template). */
export type ScreenComponent<P> = (props: P) => TemplateResult;

export interface Navigator {
	/** Show `screen` on top; the one below keeps its state, covered. */
	push(screen: () => TemplateResult): void;
	push<P>(screen: ScreenComponent<P>, props: P): void;
	/** End the top screen and show the one below. False when only one is left. */
	pop(): boolean;
	/** Swap the top screen for `screen`: the replaced one ends. */
	replace(screen: () => TemplateResult): void;
	replace<P>(screen: ScreenComponent<P>, props: P): void;
	/** Whether `pop` has a screen to go back to (reactive). */
	canGoBack(): boolean;
}

/** What a screen reads with `useScreen()`: its stack, and whether it is shown. */
export interface Screen extends Navigator {
	/**
	 * True while this screen is the one shown: on top of its stack, in a stack
	 * that is itself shown (reactive). A covered screen's effects keep running;
	 * one that should pause reads this:
	 *
	 *     effect(() => { if (screen.focused()) poll(); });
	 */
	focused(): boolean;
}

export interface StackOptions {
	/** `slide` (default): in from the right edge, the covered screen drifting left; `none`: at once. */
	transition?: "slide" | "none";
	/** The transition's length in ms. Default 300. */
	duration?: number;
	/**
	 * Painted behind each screen. None by default: a screen paints its own
	 * (its root's `bg-…`), and a colour here is one more full-screen layer the
	 * GPU fills on every frame. Set it when screens leave areas transparent,
	 * or the covered screen shows through them while a transition runs.
	 */
	background?: string;
	/**
	 * What the back button does when it reaches this stack, in place of
	 * `pop()`: true when it went back. Server-driven pages ask photon, whose
	 * history knows which page comes back.
	 */
	back?: () => boolean;
}

const ScreenContext = createContext<Screen | undefined>(
	"orbit screen",
	undefined,
);

/** The screen this component is part of (in its setup, or in a slot it built). */
export function useScreen(): Screen {
	const screen = inject(ScreenContext);
	if (screen === undefined) {
		throw new OrbitError(
			"E_ORBIT_NO_SCREEN",
			"[orbit] useScreen() outside a screen: it reads the screen a stack shows, from a component that screen built",
		);
	}
	return screen;
}

/** How far the covered screen drifts left, in widths. */
const COVERED_SHIFT = 0.3;

/** @internal What the renderer gives a stack to build a screen: its children and their disposers. */
export type ScreenBuilder = (
	result: TemplateResult,
) => [Child[], Array<() => void>];

interface Entry {
	readonly render: () => TemplateResult;
	readonly top: Signal<boolean>;
	view: NativeNode | null;
	disposers: Array<() => void>;
	x: MotionValue | null;
	visible: MotionValue | null;
	leaving: ReturnType<typeof setTimeout> | null;
}

// Provides the screen, then builds it: what the screen creates injects it.
const ScreenFrame = component(
	(props: { screen: Screen; render: () => TemplateResult }) => {
		provide(ScreenContext, props.screen);
		return props.render();
	},
);

/** Stacks shown now, in the order they were shown: the back button asks the last first. */
const shown: Stack[] = [];

/**
 * The back button or gesture: pop the innermost shown stack that can.
 * False when none can, and the platform's own back applies (leave the app).
 */
export function goBack(): boolean {
	for (let i = shown.length - 1; i >= 0; i--) {
		const stack = shown[i];
		if (stack?.isShown() && stack.back()) return true;
	}
	return false;
}

export class Stack implements Navigator {
	readonly #run = captureContext();
	readonly #parent = inject(ScreenContext);
	readonly #transition: "slide" | "none";
	readonly #duration: number;
	readonly #background: string | undefined;
	readonly #back: (() => boolean) | undefined;
	readonly #depth = signal(1);
	#entries: Entry[] = [];
	#leaving: Entry[] = [];
	readonly #region = new Region();
	#container: NativeNode | null = null;
	#build: ScreenBuilder | null = null;

	constructor(initial: Entry["render"], options: StackOptions) {
		this.#transition = options.transition ?? "slide";
		this.#duration = options.duration ?? 300;
		this.#background = options.background;
		this.#back = options.back;
		this.#entries = [this.#entry(initial)];
	}

	push(screen: () => TemplateResult): void;
	push<P>(screen: ScreenComponent<P>, props: P): void;
	push<P>(screen: ScreenComponent<P | undefined>, props?: P): void {
		const entry = this.#entry(() => screen(props));
		const below = this.#entries.at(-1);
		this.#entries.push(entry);
		this.#depth(this.#entries.length);
		if (!this.#container) return;
		if (below) this.#cover(below);
		this.#show(entry, true);
	}

	pop(): boolean {
		if (this.#entries.length < 2) return false;
		const top = this.#entries.pop();
		const below = this.#entries.at(-1);
		this.#depth(this.#entries.length);
		if (!top || !below) return false;
		this.#leave(top, true);
		below.top(true);
		if (this.#container) {
			below.visible?.set(1);
			if (this.#animated()) below.x?.timing(0, { duration: this.#duration });
			else below.x?.set(0);
		}
		return true;
	}

	replace(screen: () => TemplateResult): void;
	replace<P>(screen: ScreenComponent<P>, props: P): void;
	replace<P>(screen: ScreenComponent<P | undefined>, props?: P): void {
		const entry = this.#entry(() => screen(props));
		const old = this.#entries.pop();
		this.#entries.push(entry);
		if (old) this.#leave(old, false);
		if (this.#container) this.#show(entry, true);
	}

	/**
	 * Swap the top screen for `screen` at once, with no transition: the same
	 * place showing something new (a page reloaded with new props).
	 */
	replaceInPlace<P>(screen: ScreenComponent<P>, props: P): void {
		const entry = this.#entry(() => screen(props));
		const old = this.#entries.pop();
		this.#entries.push(entry);
		if (old) this.#leave(old, false, false);
		if (this.#container) this.#show(entry, false);
	}

	/** End every screen and start again from `screen`, at once. */
	reset<P>(screen: ScreenComponent<P>, props: P): void {
		const entry = this.#entry(() => screen(props));
		const old = this.#entries.splice(0);
		this.#entries = [entry];
		this.#depth(1);
		for (const ended of old) this.#leave(ended, false, false);
		if (this.#container) this.#show(entry, false);
	}

	/** What the back button does here: the `back` option, or `pop()`. */
	back(): boolean {
		return this.#back === undefined ? this.pop() : this.#back();
	}

	canGoBack(): boolean {
		return this.#depth() > 1;
	}

	/** Whether this stack is on screen: not inside a covered screen. */
	isShown(): boolean {
		return this.#container !== null && (this.#parent?.focused() ?? true);
	}

	/**
	 * @internal The renderer shows the stack here, once: `build` makes a
	 * screen's native children, `ended` takes what ends the stack with the
	 * scope that shows it.
	 */
	attach(build: ScreenBuilder, ended: (end: () => void) => void): NativeNode {
		if (this.#container) {
			throw new OrbitError(
				"E_ORBIT_STACK_SHOWN",
				"[orbit] a stack is shown in one place: this one is already in a template",
			);
		}
		this.#build = build;
		this.#container = new NativeNode(
			"RCTView",
			flatten({ flex: 1, overflow: "hidden" }),
			[this.#region],
		);
		for (const entry of this.#entries) this.#show(entry, false);
		for (const entry of this.#entries.slice(0, -1)) {
			entry.visible?.set(0);
		}
		shown.push(this);
		ended(() => this.#end());
		return this.#container;
	}

	#entry(render: () => TemplateResult): Entry {
		return {
			render,
			top: signal(true),
			view: null,
			disposers: [],
			x: null,
			visible: null,
			leaving: null,
		};
	}

	#screen(entry: Entry): Screen {
		const parent = this.#parent;
		const stack = this;
		return {
			focused: () => entry.top() && (parent?.focused() ?? true),
			push<P>(screen: ScreenComponent<P | undefined>, props?: P) {
				stack.push(screen, props);
			},
			pop: () => stack.pop(),
			replace<P>(screen: ScreenComponent<P | undefined>, props?: P) {
				stack.replace(screen, props);
			},
			canGoBack: () => stack.canGoBack(),
		};
	}

	#animated(): boolean {
		return this.#transition === "slide" && this.#width() > 0;
	}

	/** The stack's width in dp, as last laid out (0 before its first commit). */
	#width(): number {
		const container = this.#container;
		if (!container) return 0;
		const frames: unknown = JSON.parse(
			treeHost().layout(JSON.stringify([container.tag])),
		);
		const frame: unknown = Array.isArray(frames) ? frames[0] : null;
		const width: unknown = Array.isArray(frame) ? frame[2] : 0;
		return typeof width === "number" ? width : 0;
	}

	/** Build `entry`'s screen and put its view on top; `arrive` slides it in. */
	#show(entry: Entry, arrive: boolean): void {
		const build = this.#build;
		if (!build) return;
		const width = arrive && this.#animated() ? this.#width() : 0;
		const screen = this.#screen(entry);
		const [children, disposers] = untrack(() =>
			build(this.#run(() => ScreenFrame({ screen, render: entry.render }))),
		);
		const view = new NativeNode(
			"RCTView",
			flatten({
				position: "absolute",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				...(this.#background === undefined
					? {}
					: { backgroundColor: this.#background }),
			}),
			children,
		);
		entry.view = view;
		entry.disposers = disposers;
		const x = new MotionValue(width);
		const visible = new MotionValue(1);
		entry.x = x;
		entry.visible = visible;
		afterCommit(() => bindMotion(view.tag, { translateX: x, visible }));
		if (width > 0) x.timing(0, { duration: this.#duration });
		this.#layout();
	}

	/**
	 * `entry` is no longer on top: it drifts left, and hides the frame its
	 * cover has arrived — at once, a frame later, so the cover is mounted.
	 */
	#cover(entry: Entry): void {
		entry.top(false);
		const animated = this.#animated();
		if (animated) {
			const width = this.#width();
			entry.x?.timing(-COVERED_SHIFT * width, { duration: this.#duration });
		}
		entry.visible?.after(animated ? this.#duration : 0, 0);
	}

	/**
	 * `entry` ends now — its effects stop, its unmount hooks run — and its
	 * view goes once the transition is over: sliding out to the right when
	 * popped, staying under its replacement when replaced.
	 */
	#leave(entry: Entry, slide: boolean, animate = true): void {
		entry.top(false);
		for (const end of entry.disposers.splice(0)) end();
		if (!entry.view) return;
		this.#leaving.push(entry);
		const animated = animate && this.#animated();
		if (animated && slide) {
			entry.x?.timing(this.#width(), { duration: this.#duration });
		}
		entry.leaving = setTimeout(
			() => this.#remove(entry),
			animated ? this.#duration : 0,
		);
	}

	#remove(entry: Entry): void {
		if (entry.leaving !== null) clearTimeout(entry.leaving);
		entry.leaving = null;
		const at = this.#leaving.indexOf(entry);
		if (at >= 0) this.#leaving.splice(at, 1);
		entry.view = null;
		entry.x?.dispose();
		entry.visible?.dispose();
		entry.x = null;
		entry.visible = null;
		this.#layout();
	}

	/**
	 * The views in drawing order: the covered screens, then those leaving
	 * (a popped screen slides out over the one it uncovers, a replaced one
	 * stays under its replacement), then the top.
	 */
	#layout(): void {
		const views = (entries: readonly Entry[]) =>
			entries.flatMap((entry) => (entry.view ? [entry.view] : []));
		const top = this.#entries.at(-1);
		this.#region.set([
			...views(this.#entries.slice(0, -1)),
			...views(this.#leaving),
			...(top ? views([top]) : []),
		]);
	}

	#end(): void {
		const at = shown.indexOf(this);
		if (at >= 0) shown.splice(at, 1);
		for (const entry of [...this.#entries, ...this.#leaving]) {
			entry.top(false);
			for (const end of entry.disposers.splice(0)) end();
			if (entry.leaving !== null) clearTimeout(entry.leaving);
			entry.x?.dispose();
			entry.visible?.dispose();
		}
		this.#entries = [];
		this.#leaving = [];
		this.#container = null;
	}
}

/** A stack of screens, `initial` at the bottom; show it with `html\`${stack}\``. */
export function createStack(
	initial: () => TemplateResult,
	options?: StackOptions,
): Stack;
/** …with the first screen's props. */
export function createStack<P>(
	initial: ScreenComponent<P>,
	options: StackOptions & { props: P },
): Stack;
export function createStack<P>(
	initial: ScreenComponent<P | undefined>,
	options: StackOptions & { props?: P } = {},
): Stack {
	return new Stack(() => initial(options.props), options);
}
