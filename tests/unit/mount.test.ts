import { component, html, onMount, signal } from "@c9up/aurora/core";
import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { colorToArgb, MotionValue, mount, useHost } from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

/** The first entry of a list the test expects to be non-empty. */
function first<T>(list: readonly T[]): T {
	const item = list[0];
	if (item === undefined) throw new Error("expected at least one entry");
	return item;
}

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

describe("mount", () => {
	it("sends one batch that creates the tree, sets children, then the root", () => {
		const host = setup();
		mount(
			html`<div class="p-4 bg-white"><p class="text-sm text-slate-500">Il reste <strong>${2}</strong></p></div>`,
			{ viewport },
		);

		expect(host.viewport).toEqual([400, 800]);
		expect(host.batches).toHaveLength(1);
		const ops = host.batches[0] ?? [];
		expect(ops.at(-1)?.[0]).toBe("r");
		const [textTag, text] = first(host.all("RCTText"));
		expect(text.props).toMatchObject({
			fontSize: 14,
			color: colorToArgb("#62748e"),
		});
		expect(host.text(textTag)).toBe("Il reste 2");
		const [, strong] = first(host.all("RCTVirtualText"));
		expect(strong.props).toMatchObject({ fontWeight: "700" });
		const views = host.all("RCTView").map(([, v]) => v.props);
		expect(views).toContainEqual(
			expect.objectContaining({
				padding: 16,
				backgroundColor: colorToArgb("#ffffff"),
			}),
		);
	});

	it("patches only the raw text a signal feeds", async () => {
		const host = setup();
		const count = signal(0);
		mount(html`<p>Compteur : ${count}</p>`, { viewport });
		const [rawTag] = first(
			host.all("RCTRawText").filter(([, n]) => n.props.text === "0"),
		);

		count(1);
		await Promise.resolve();

		expect(host.batches).toHaveLength(2);
		expect(host.batches[1]).toEqual([["u", rawTag, { text: "1" }]]);
	});

	it("commits at once on flush(), and not again at the end of the turn", async () => {
		const host = setup();
		const count = signal(0);
		const root = mount(html`<p>${count}</p>`, { viewport });

		count(1);
		root.flush();
		expect(host.batches).toHaveLength(2);
		await Promise.resolve();

		expect(host.batches).toHaveLength(2);
	});

	it("coalesces writes made in one turn into one commit", async () => {
		const host = setup();
		const a = signal("a");
		const b = signal("b");
		mount(html`<p>${a} ${b}</p>`, { viewport });

		a("x");
		b("y");
		await Promise.resolve();

		expect(host.batches).toHaveLength(2);
		expect(host.batches[1]?.map((op) => op[0])).toEqual(["u", "u"]);
	});

	it("replaces a reactive list, and forgets the nodes the host dropped", async () => {
		const host = setup();
		const items = signal<readonly string[]>(["a", "b"]);
		const root = mount(
			html`<div>${() => items().map((item) => html`<p>${item}</p>`)}</div>`,
			{ viewport },
		);
		const before = host.all("RCTText").map(([tag]) => tag);

		items(["c"]);
		await Promise.resolve();

		const after = host.all("RCTText");
		expect(after.map(([tag]) => host.text(tag))).toEqual(["c"]);
		expect(before.some((tag) => host.nodes.has(tag))).toBe(false);
		expect(root.reports.at(-1)?.deleted.length).toBeGreaterThanOrEqual(4);
	});

	it("runs a component's onMount once its views reached the host", () => {
		const host = setup();
		const seen: number[] = [];
		const Card = component(() => {
			onMount(() => {
				seen.push(host.batches.length);
			});
			return html`<div class="p-2"><p>card</p></div>`;
		});
		mount(Card({}), { viewport });
		expect(seen).toEqual([1]);
	});

	it("shows an element in a slot that held nothing at first", () => {
		const host = setup();
		const open = signal(false);
		const Badge = component(() => html`<p>badge</p>`);
		const root = mount(
			html`<div><p>page</p>${() => (open() ? Badge() : null)}</div>`,
			{ viewport },
		);
		open(true);
		root.flush();
		const texts = host.all("RCTText").map(([tag]) => host.text(tag));
		expect(texts).toEqual(["page", "badge"]);
	});

	it("makes each child of a flex container its own item", () => {
		const host = setup();
		mount(
			html`<div class="flex"><span>Ligne 1</span><span>appuie</span></div>`,
			{ viewport },
		);
		const texts = host.all("RCTText").map(([tag]) => host.text(tag));
		expect(texts).toEqual(["Ligne 1", "appuie"]);
		const row = host
			.all("RCTView")
			.find(([, v]) => v.props.flexDirection === "row");
		expect(row?.[1].children).toHaveLength(2);
	});
});

describe("gestures", () => {
	// orbit-host recognizes gestures on the UI thread (crates/orbit-host/src/gesture.rs,
	// tested there); JS declares them and receives the outcome.
	function row(handlers: string) {
		const host = setup();
		const seen: Array<{ [key: string]: unknown }> = [];
		const record = (event: { [key: string]: unknown }) => seen.push(event);
		const templates: { [key: string]: ReturnType<typeof html> } = {
			click: html`<div class="p-4" @click=${record}><p>Ligne</p></div>`,
			all: html`<div class="p-4" @click=${record} @longpress=${record} @pan=${record} @swipe=${record}><p>Ligne</p></div>`,
			none: html`<div class="p-4"><p>Ligne</p></div>`,
		};
		const template = templates[handlers];
		if (!template) throw new Error(handlers);
		mount(html`<div>${template}</div>`, { viewport });
		const entry = host.all("RCTView").find(([, n]) => n.props.padding === 16);
		if (!entry) throw new Error("no row");
		const [tag, node] = entry;
		const deliver = (type: string, data: string) =>
			host.handler?.(tag, type, 0, 0, data);
		return { node, seen, deliver };
	}

	it("tells the host which gestures a node listens to", () => {
		expect(row("click").node.props.gestures).toBe(1);
		expect(row("all").node.props.gestures).toBe(15);
		expect(row("none").node.props.gestures).toBeUndefined();
	});

	it("hands each recognized gesture to its handler, with its numbers", () => {
		const { seen, deliver } = row("all");
		deliver("topPress", '{"x":12,"y":11}');
		deliver("topLongPress", '{"x":12,"y":11}');
		deliver("topPan", '{"phase":"move","dx":-30,"dy":2,"vx":-400,"vy":10}');
		deliver("topSwipe", '{"direction":"left","vx":-900,"vy":0}');
		expect(seen).toEqual([
			{ type: "click", x: 12, y: 11 },
			{ type: "longpress", x: 12, y: 11 },
			{ type: "pan", phase: "move", dx: -30, dy: 2, vx: -400, vy: 10 },
			{ type: "swipe", direction: "left", vx: -900, vy: 0 },
		]);
	});

	it("ignores what it did not ask for, and data it cannot read", () => {
		const { seen, deliver } = row("click");
		deliver("topSwipe", '{"direction":"left"}');
		deliver("topPress", "not json");
		expect(seen).toEqual([{ type: "click" }]);
	});
});

describe("motion and scroll", () => {
	it("binds motion values to the view once it is committed", () => {
		const host = setup();
		const shuttle = new MotionValue(0);
		shuttle.timing(300, { duration: 1000, loop: true, yoyo: true });
		mount(
			html`<div class="w-16 h-2" motion=${{ translateX: shuttle }}></div>`,
			{ viewport },
		);
		const [, bar] = host
			.all("RCTView")
			.find(([, v]) => v.props.width === 64) ?? [0];
		expect(bar).toBeDefined();
		const bind = host.motion.find((call) => call[0] === "bind");
		expect(bind?.[2]).toBe(1);
		expect(bind?.[3]).toBe(shuttle.tag);
		expect(host.motion.find((call) => call[0] === "frames")?.[4]).toBe(true);
	});

	it("maps a scrolling element to a scroll view around its content, and feeds scroll-y", () => {
		const host = setup();
		const scrollY = new MotionValue(0);
		mount(
			html`<div class="flex-1 overflow-y-auto p-4 gap-2" scroll-y=${scrollY}><p>a</p><p>b</p></div>`,
			{ viewport },
		);
		const [scrollTag, scroll] = first(host.all("RCTScrollView"));
		expect(scroll.children).toHaveLength(1);
		const content = host.nodes.get(scroll.children[0] ?? 0);
		expect(content?.props).toMatchObject({ padding: 16, gap: 8 });
		expect(host.motion).toContainEqual(["bindScroll", scrollTag, scrollY.tag]);
	});

	it("refuses a motion attribute that is not motion values", () => {
		setup();
		expectCode(
			() => mount(html`<div motion=${{ opacity: 1 }}></div>`, { viewport }),
			"E_ORBIT_INVALID_MOTION",
		);
	});
});

describe("errors and colours", () => {
	it("names an element with no native mapping", () => {
		setup();
		expectCode(
			() => mount(html`<div><select></select></div>`, { viewport }),
			"E_ORBIT_UNSUPPORTED_ELEMENT",
		);
	});

	it("reads hex, rgb() and rgba() into Android's signed ARGB", () => {
		expect(colorToArgb("#ffffff")).toBe(-1);
		expect(colorToArgb("#000")).toBe(-16777216);
		expect(colorToArgb("rgba(255, 255, 255, 0.2)")).toBe((51 << 24) | 0xffffff);
		expect(colorToArgb("rgb(0 0 255)")).toBe(-16776961);
		expect(colorToArgb("transparent")).toBe(0);
		expectCode(() => colorToArgb("rebeccapurple"), "E_ORBIT_INVALID_COLOR");
	});
});
