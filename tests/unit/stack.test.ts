import {
	component,
	createContext,
	effect,
	html,
	inject,
	onUnmount,
	provide,
	signal,
} from "@c9up/aurora/core";
import { Exception } from "@c9up/flare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createStack,
	mount,
	type Screen,
	useHost,
	useScreen,
} from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

function setup(): FakeHost {
	const host = new FakeHost();
	useHost(host);
	return host;
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(Exception);
		expect(Reflect.get(Object(error), "code")).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
}

/** The texts on screen now, in drawing order. */
function texts(host: FakeHost): string[] {
	return host.all("RCTText").map(([tag]) => host.text(tag));
}

/** The screens' views: the stack container's children, in drawing order. */
function screens(host: FakeHost): number[] {
	const container = host
		.all("RCTView")
		.find(([, node]) => node.props.overflow === "hidden");
	return container?.[1].children ?? [];
}

let screen: Screen | undefined;

/** A screen that hands its handle to the test, and counts its renders. */
const Labelled = component((props: { label: string }) => {
	screen = useScreen();
	return html`<p>${props.label}</p>`;
});

function current(): Screen {
	if (!screen) throw new Error("no screen built yet");
	return screen;
}

beforeEach(() => {
	vi.useFakeTimers();
	screen = undefined;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a stack of screens", () => {
	it("shows the first screen, pushes on top, and keeps the covered one built", () => {
		const host = setup();
		const count = signal(0);
		const Home = component(() => {
			screen = useScreen();
			return html`<p>home ${() => count()}</p>`;
		});
		const root = mount(html`${createStack(Home)}`, { viewport });
		expect(texts(host)).toEqual(["home 0"]);
		const home = current();
		expect(home.focused()).toBe(true);
		expect(home.canGoBack()).toBe(false);

		home.push(Labelled, { label: "detail" });
		root.flush();
		expect(texts(host)).toEqual(["home 0", "detail"]);
		expect(screens(host)).toHaveLength(2);
		expect(home.focused()).toBe(false);
		expect(current().focused()).toBe(true);
		expect(home.canGoBack()).toBe(true);

		// Covered, still live: its state and its bindings carry on.
		count(5);
		root.flush();
		expect(texts(host)).toEqual(["home 5", "detail"]);
	});

	it("pops: the top screen's effects end at once, its views once it has slid out", () => {
		const host = setup();
		const ticks = signal(0);
		const seen: number[] = [];
		let unmounted = 0;
		const Detail = component(() => {
			effect(() => {
				seen.push(ticks());
			});
			onUnmount(() => {
				unmounted++;
			});
			return html`<p>detail</p>`;
		});
		const Home = component(() => {
			screen = useScreen();
			return html`<p>home</p>`;
		});
		const root = mount(html`${createStack(Home)}`, { viewport });
		const home = current();
		home.push(Detail);
		root.flush();
		ticks(1);
		expect(seen).toEqual([0, 1]);

		expect(home.pop()).toBe(true);
		expect(unmounted).toBe(1);
		ticks(2);
		expect(seen).toEqual([0, 1]);
		expect(home.focused()).toBe(true);
		root.flush();
		// Still there, sliding out over the screen it uncovers.
		expect(texts(host)).toEqual(["home", "detail"]);

		vi.advanceTimersByTime(300);
		root.flush();
		expect(texts(host)).toEqual(["home"]);
		expect(home.pop()).toBe(false);
	});

	it("slides on the UI thread: the new screen in from the right, the covered one left, then hidden", () => {
		const host = setup();
		const Home = component(() => {
			screen = useScreen();
			return html`<p>home</p>`;
		});
		const root = mount(html`${createStack(Home)}`, { viewport });
		const [homeView] = screens(host);
		host.motion.length = 0;

		current().push(Labelled, { label: "detail" });
		root.flush();
		const [, detailView] = screens(host);
		const values = host.motion.filter(([kind]) => kind === "value");
		// The arriving screen starts a width to the right and eases to 0.
		expect(values[0]?.[2]).toBe(400);
		const arriving = values[0]?.[1];
		expect(host.motion).toContainEqual(["frames", arriving, 19, 0, false]);
		expect(host.motion).toContainEqual(["bind", detailView, 1, arriving]);
		// The covered one drifts left, and hides on the transition's last frame.
		const covered = host.motion.filter(
			([kind, , , to]) => kind === "frames" && to === -120,
		);
		expect(covered).toHaveLength(1);
		const hides = host.motion.filter(
			([kind, , length, to]) => kind === "frames" && length === 19 && to === 0,
		);
		expect(hides.map(([, tag]) => tag)).not.toContain(undefined);
		expect(hides).toHaveLength(2);
		expect(homeView).toBeTypeOf("number");
	});

	it("replaces: the old screen ends and leaves once its replacement has arrived", () => {
		const host = setup();
		let ended = 0;
		const Login = component(() => {
			screen = useScreen();
			onUnmount(() => {
				ended++;
			});
			return html`<p>login</p>`;
		});
		const root = mount(html`${createStack(Login)}`, { viewport });
		current().replace(Labelled, { label: "home" });
		expect(ended).toBe(1);
		root.flush();
		expect(texts(host)).toEqual(["login", "home"]);
		vi.advanceTimersByTime(300);
		root.flush();
		expect(texts(host)).toEqual(["home"]);
		expect(current().canGoBack()).toBe(false);
		const disposed = host.motion.filter(([kind]) => kind === "dispose");
		expect(disposed).toHaveLength(2);
	});

	it("switches at once with transition none, hiding the covered one a frame later", () => {
		const host = setup();
		const Home = component(() => {
			screen = useScreen();
			return html`<p>home</p>`;
		});
		const root = mount(html`${createStack(Home, { transition: "none" })}`, {
			viewport,
		});
		host.motion.length = 0;
		current().push(Labelled, { label: "detail" });
		root.flush();
		expect(host.motion.filter(([kind]) => kind === "value")[0]?.[2]).toBe(0);
		expect(host.motion).toContainEqual([
			"frames",
			expect.any(Number),
			2,
			0,
			false,
		]);
		current().pop();
		vi.advanceTimersByTime(0);
		root.flush();
		expect(texts(host)).toEqual(["home"]);
	});

	it("paints nothing behind a screen unless asked to", () => {
		const host = setup();
		mount(html`${createStack(Labelled, { props: { label: "a" } })}`, {
			viewport,
		});
		const [plain] = screens(host);
		expect(host.nodes.get(plain ?? 0)?.props.backgroundColor).toBeUndefined();
		const other = setup();
		mount(
			html`${createStack(Labelled, { props: { label: "b" }, background: "#0f172a" })}`,
			{ viewport },
		);
		const [painted] = screens(other);
		expect(other.nodes.get(painted ?? 0)?.props.backgroundColor).toBeTypeOf(
			"number",
		);
	});

	it("gives the first screen its props, and pushed ones theirs", () => {
		const host = setup();
		const root = mount(
			html`${createStack(Labelled, { props: { label: "first" } })}`,
			{ viewport },
		);
		current().push(Labelled, { label: "second" });
		root.flush();
		expect(texts(host)).toEqual(["first", "second"]);
	});

	it("lets a covered screen pause what it does", () => {
		setup();
		const polls: boolean[] = [];
		const Feed = component(() => {
			const self = useScreen();
			screen = self;
			effect(() => {
				polls.push(self.focused());
			});
			return html`<p>feed</p>`;
		});
		const root = mount(html`${createStack(Feed)}`, { viewport });
		const feed = current();
		feed.push(Labelled, { label: "detail" });
		root.flush();
		feed.pop();
		expect(polls).toEqual([true, false, true]);
	});

	it("builds a pushed screen under the providers around the stack", () => {
		const host = setup();
		const Theme = createContext<string>("theme");
		const Themed = component(() => {
			const theme = inject(Theme);
			const open = signal(false);
			screen = useScreen();
			// A child built later, in a slot: it still sees the context.
			const Badge = component(() => html`<p>${inject(Theme)} badge</p>`);
			return html`<div>
				<p>${theme} page</p>
				${() => (open() ? Badge() : null)}
				<button @click=${() => open(true)}>open</button>
			</div>`;
		});
		let stack: ReturnType<typeof createStack> | undefined;
		const App = component(() => {
			provide(Theme, "dark");
			stack = createStack(() => html`<p>home</p>`);
			return html`${stack}`;
		});
		const root = mount(App(), { viewport });
		stack?.push(Themed);
		root.flush();
		expect(texts(host)).toContain("dark page");
		const [buttonTag] = host
			.all("RCTView")
			.filter(([, node]) => node.props.gestures === 1)
			.map(([tag]) => tag);
		expect(buttonTag).toBeTypeOf("number");
		host.handler?.(buttonTag ?? 0, "topPress", 0, 0, "{}");
		root.flush();
		expect(texts(host)).toContain("dark badge");
	});

	it("refuses useScreen() outside a screen, and one stack in two places", () => {
		setup();
		expectCode(() => useScreen(), "E_ORBIT_NO_SCREEN");
		const stack = createStack(() => html`<p>home</p>`);
		expectCode(
			() => mount(html`${stack}${stack}`, { viewport }),
			"E_ORBIT_STACK_SHOWN",
		);
	});
});
