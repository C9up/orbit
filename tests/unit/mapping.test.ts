import { html, signal } from "@c9up/aurora/core";
import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import {
	colorScheme,
	colorToArgb,
	MotionValue,
	mount,
	unknownClasses,
	useHost,
	useStyles,
} from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

function setup(): FakeHost {
	const host = new FakeHost();
	useHost(host);
	return host;
}

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof Exception) return error.code ?? "no code";
		throw error;
	}
	return "none";
}

/** The props of the first host node of `viewName` whose props match `where`. */
function propsOf(
	host: FakeHost,
	viewName: string,
	where: (props: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> {
	const found = host.all(viewName).find(([, n]) => where(n.props));
	if (!found) throw new Error(`no ${viewName}`);
	return found[1].props;
}

describe("the app's style table", () => {
	it("reads box and text styles from the app's Tailwind build", () => {
		const host = setup();
		mount(
			html`<div class="p-4 px-2 mt-1 gap-3 w-16 h-2 rounded-lg font-semibold text-xl text-white bg-violet-500 border border-white/30 items-center justify-between self-start"><p>x</p></div>`,
			{ viewport },
		);
		expect(propsOf(host, "RCTView", (p) => p.width === 64)).toMatchObject({
			paddingVertical: 16,
			paddingHorizontal: 8,
			marginTop: 4,
			gap: 12,
			width: 64,
			height: 8,
			borderRadius: 10,
			backgroundColor: colorToArgb("#8e51ff"),
			borderWidth: 1,
			borderColor: colorToArgb("rgba(255, 255, 255, 0.302)"),
			alignItems: "center",
			justifyContent: "space-between",
			alignSelf: "flex-start",
		});
		// Text styles are inherited by the text inside, as CSS does.
		expect(propsOf(host, "RCTText")).toMatchObject({
			fontWeight: "600",
			fontSize: 20,
			color: colorToArgb("#ffffff"),
		});
	});

	it("reads shadows, backdrop blur, positions and translucent colours", () => {
		const host = setup();
		mount(
			html`<div><div class="shadow-lg backdrop-blur-xl absolute top-0 left-4 inset-x-0 bg-slate-900/40"><p class="text-white/80">x</p></div></div>`,
			{ viewport },
		);
		const box = propsOf(host, "RCTView", (p) => p.position === "absolute");
		expect(box).toMatchObject({
			shadowX: 0,
			shadowY: 10,
			shadowBlur: 15,
			shadowSpread: -3,
			shadowColor: colorToArgb("rgba(0, 0, 0, 0.102)"),
			backdropBlur: 24,
			top: 0,
			// left-4 comes after inset-x-0 in Tailwind's output: it wins, as in a browser.
			left: 16,
			right: 0,
			backgroundColor: colorToArgb("rgba(15, 23, 43, 0.4)"),
		});
		expect(propsOf(host, "RCTText").color).toBe(
			colorToArgb("rgba(255, 255, 255, 0.8)"),
		);
	});

	it("collects the classes the stylesheet does not have", () => {
		setup();
		mount(html`<div class="p-2 bg-nope-500 not-a-class"></div>`, { viewport });
		expect(unknownClasses.has("bg-nope-500")).toBe(true);
		expect(unknownClasses.has("not-a-class")).toBe(true);
		expect(unknownClasses.has("p-2")).toBe(false);
	});

	it("applies an attribute variant, and follows the attribute", async () => {
		const host = setup();
		const state = signal("unchecked");
		mount(
			html`<div><div data-state="${state}" class="h-4 bg-white data-[state=checked]:bg-primary"><span>x</span></div></div>`,
			{ viewport },
		);
		const view = () => propsOf(host, "RCTView", (p) => p.height === 16);
		expect(view().backgroundColor).toBe(colorToArgb("#ffffff"));
		state("checked");
		await Promise.resolve();
		expect(view().backgroundColor).toBe(colorToArgb("#171717"));
	});

	it("takes the dark scheme's values, and dark: variants", async () => {
		const host = setup();
		mount(html`<div><div class="h-5 bg-primary dark:border-2"></div></div>`, {
			viewport,
		});
		const view = () => propsOf(host, "RCTView", (p) => p.height === 20);
		expect(view()).toMatchObject({ backgroundColor: colorToArgb("#171717") });
		expect(view().borderWidth).toBeUndefined();
		colorScheme("dark");
		await Promise.resolve();
		expect(view()).toMatchObject({
			backgroundColor: colorToArgb("#e5e5e5"),
			borderWidth: 2,
		});
		colorScheme("light");
	});

	it("matches an ancestor (group-*), the children (*:) and descendants ([&_svg]:)", async () => {
		const host = setup();
		const open = signal("closed");
		mount(
			html`<div class="group *:min-h-6" data-open="${open}"><div class="h-7 group-data-[open=yes]:hidden"></div><div class="[&_svg]:size-4"><svg viewBox="0 0 1 1"><path d="M0 0h1" /></svg></div></div>`,
			{ viewport },
		);
		const hidden = () => propsOf(host, "RCTView", (p) => p.height === 28);
		expect(hidden().display).toBeUndefined();
		expect(hidden().minHeight).toBe(24);
		expect(propsOf(host, "OrbitVector")).toMatchObject({
			width: 16,
			height: 16,
		});
		open("yes");
		await Promise.resolve();
		expect(hidden().display).toBe("none");
	});

	it("matches a previous sibling (peer-*), and a viewport width (sm:)", () => {
		const host = setup();
		mount(
			html`<div><div class="peer" data-x="on"></div><div class="h-9 peer-data-[x=on]:w-10 sm:w-12"></div></div>`,
			{ viewport: { width: 400, height: 800 } },
		);
		expect(propsOf(host, "RCTView", (p) => p.height === 36).width).toBe(40);
		const wide = setup();
		mount(html`<div><div class="h-9 sm:w-12"></div></div>`, {
			viewport: { width: 700, height: 800 },
		});
		expect(propsOf(wide, "RCTView", (p) => p.height === 36).width).toBe(48);
	});

	it("composes the variables classes share: leading over text size, shrink in a flex row", () => {
		const host = setup();
		mount(
			html`<div class="flex"><p class="text-sm leading-tight">a</p><p class="text-sm">b</p><div class="h-1 hover:bg-primary"></div></div>`,
			{ viewport },
		);
		const [tight, plain] = host.all("RCTText").map(([, n]) => n.props);
		expect(tight).toMatchObject({ fontSize: 14, lineHeight: 14 * 1.25 });
		expect(plain?.lineHeight).toBeCloseTo(20, 1);
		// A flex item shrinks, as in CSS; nothing is hovered on a touch screen.
		const bar = propsOf(host, "RCTView", (p) => p.height === 4);
		expect(bar).toMatchObject({ flexShrink: 1 });
		expect(bar.backgroundColor).toBeUndefined();
	});

	it("reads the flex, size, border, text and fit properties orbit draws", () => {
		const host = setup();
		mount(
			html`<div class="flex flex-col flex-wrap items-start content-center justify-end">
				<div class="h-11 flex-1 basis-1/2 shrink-0 grow self-end relative overflow-hidden aspect-video min-w-0 max-w-sm mx-auto border-t-2 border-dashed rounded-t-md opacity-50"></div>
				<div class="h-12 flex-none fixed inset-0 border-none border-4"></div>
				<div class="h-13 flex-auto w-screen max-h-dvh my-2 ps-3 pe-1 py-0.5 gap-x-2 gap-y-4"></div>
				<p class="italic font-mono tracking-tight text-center leading-6 text-start">t</p>
				<img class="h-14 object-cover" src="https://cdn.example.com/a.jpg" />
				<input class="h-15 placeholder:text-muted-foreground field-sizing-content" />
			</div>`,
			{ viewport },
		);
		const view = (h: number) => propsOf(host, "RCTView", (p) => p.height === h);
		expect(
			propsOf(host, "RCTView", (p) => p.flexWrap === "wrap"),
		).toMatchObject({
			flexDirection: "column",
			alignItems: "flex-start",
			alignContent: "center",
			justifyContent: "flex-end",
		});
		expect(view(44)).toMatchObject({
			flexGrow: 1,
			flexShrink: 0,
			flexBasis: "50%",
			alignSelf: "flex-end",
			position: "relative",
			overflow: "hidden",
			aspectRatio: 16 / 9,
			minWidth: 0,
			maxWidth: 384,
			marginHorizontal: "auto",
			borderTopWidth: 2,
			opacity: 0.5,
		});
		expect(view(48)).toMatchObject({
			flexGrow: 0,
			flexShrink: 0,
			position: "absolute",
			top: 0,
			left: 0,
			borderWidth: 0,
		});
		expect(view(52)).toMatchObject({
			flexGrow: 1,
			width: 400,
			maxHeight: 800,
			marginVertical: 8,
			paddingLeft: 12,
			paddingRight: 4,
			paddingVertical: 2,
			rowGap: 16,
			columnGap: 8,
		});
		expect(propsOf(host, "RCTText")).toMatchObject({
			fontStyle: "italic",
			fontFamily: "monospace",
			letterSpacing: -0.4,
			textAlign: "left",
			lineHeight: 24,
		});
		expect(propsOf(host, "OrbitImage")).toMatchObject({ objectFit: "cover" });
		expect(propsOf(host, "OrbitTextInput")).toMatchObject({
			placeholderColor: colorToArgb("#737373"),
			fieldSizing: "content",
		});
	});

	it("applies the base layer: the border token, and the page's background and text on the root", () => {
		const host = setup();
		mount(html`<div class="h-3 border"></div><p>x</p>`, { viewport });
		expect(propsOf(host, "RCTView", (p) => p.height === 12)).toMatchObject({
			borderWidth: 1,
			borderColor: colorToArgb("#e5e5e5"),
		});
		expect(propsOf(host, "RCTView", (p) => p.flex === 1).backgroundColor).toBe(
			colorToArgb("#ffffff"),
		);
		expect(propsOf(host, "RCTText").color).toBe(colorToArgb("#0a0a0a"));
	});

	it("makes no box of the white space between slots in a flex container", () => {
		const host = setup();
		mount(
			html`<div class="flex gap-2">
				${html`<p>a</p>`}
				${html`<p>b</p>`}
			</div>`,
			{ viewport },
		);
		expect(host.all("RCTText").map(([tag]) => host.text(tag))).toEqual([
			"a",
			"b",
		]);
	});

	it("refuses a table it cannot read", () => {
		expect(codeOf(() => useStyles({ version: 2 }))).toBe("E_ORBIT_STYLE_TABLE");
	});
});

describe("template mapping", () => {
	it("restyles a view when a reactive class changes, and clears what left", async () => {
		const host = setup();
		const on = signal(true);
		mount(
			html`<div class="${() => (on() ? "p-4 bg-white" : "p-2")}"><p>x</p></div>`,
			{ viewport },
		);
		const view = host.all("RCTView").find(([, v]) => v.props.padding === 16);
		expect(view).toBeDefined();

		on(false);
		await Promise.resolve();

		const patch = host.batches.at(-1)?.find((op) => op[0] === "u");
		expect(patch?.[2]).toEqual({ padding: 8, backgroundColor: null });
	});

	it("restyles a text when its reactive class changes", async () => {
		const host = setup();
		const done = signal(false);
		mount(
			html`<p class="${() => (done() ? "text-green-600" : "text-slate-400")}">fait</p>`,
			{ viewport },
		);

		done(true);
		await Promise.resolve();

		const patch = host.batches.at(-1)?.find((op) => op[0] === "u");
		expect(patch?.[2]).toMatchObject({ color: colorToArgb("#00a63e") });
	});

	it("swaps a reactive template inside text, and plain arrays of values", async () => {
		const host = setup();
		const strong = signal(true);
		mount(
			html`<p>${() => (strong() ? html`<strong>a</strong>` : "b")} ${["x", 1]}</p>`,
			{ viewport },
		);
		const tag = host.all("RCTText")[0]?.[0] ?? 0;
		expect(host.text(tag)).toBe("a x1");

		strong(false);
		await Promise.resolve();

		const after = host.all("RCTText")[0]?.[0] ?? 0;
		expect(host.text(after)).toBe("b x1");
	});

	it("decodes entities, skips comments, reads unquoted attributes and void elements", () => {
		const host = setup();
		mount(
			html`<div class=p-2><!-- note --><p>a &amp; b&nbsp;c</p><br><hr/></div>`,
			{ viewport },
		);
		const texts = host.all("RCTText").map(([tag]) => host.text(tag));
		// &nbsp; is a no-break space, as on the web.
		expect(texts).toContain("a & b\u00a0c");
		expect(host.all("RCTView").some(([, v]) => v.props.padding === 8)).toBe(
			true,
		);
	});

	it("renders nothing for null, false and empty values", () => {
		const host = setup();
		mount(html`<div>${null}${false}${""}<p>ok</p></div>`, { viewport });
		expect(host.all("RCTText").map(([tag]) => host.text(tag))).toEqual(["ok"]);
	});

	it("refuses a block element inside text, and a scroll binding that is not a motion value", () => {
		setup();
		expect(codeOf(() => mount(html`<p><div>no</div></p>`, { viewport }))).toBe(
			"E_ORBIT_BLOCK_IN_TEXT",
		);
		expect(
			codeOf(() =>
				mount(html`<div class="overflow-y-auto" scroll-y=${1}></div>`, {
					viewport,
				}),
			),
		).toBe("E_ORBIT_INVALID_SCROLL_BINDING");
		expect(
			codeOf(() => mount(html`<div motion=${1}></div>`, { viewport })),
		).toBe("E_ORBIT_INVALID_MOTION");
	});

	it("refuses a slot where aurora's scanner refuses it", () => {
		setup();
		expect(() => mount(html`<script>${"x"}</script>`, { viewport })).toThrow();
	});
});

describe("motion values", () => {
	it("sends set, stop, spring and interpolation to the host", () => {
		const host = setup();
		const v = new MotionValue(1);
		v.set(0.8);
		v.spring(1, { stiffness: 260, damping: 7 });
		v.stop();
		v.timing(10);
		const fade = v.interpolate([0, 200], [1, 0.2]);
		expect(host.motion.map((call) => call[0])).toEqual([
			"value",
			"set",
			"spring",
			"stop",
			"frames",
			"interpolate",
		]);
		expect(host.motion.at(-1)).toEqual([
			"interpolate",
			fade.tag,
			v.tag,
			[0, 200],
			[1, 0.2],
		]);
	});
});

describe("colours", () => {
	it("reads 4- and 8-digit hex and percentages, and refuses what it cannot read", () => {
		expect(colorToArgb("#fff8")).toBe((0x88 << 24) | 0xffffff);
		expect(colorToArgb("#00000080")).toBe(0x80 << 24);
		expect(colorToArgb("rgb(100%, 0%, 0%)")).toBe(-65536);
		expect(colorToArgb("rgba(0, 0, 0, 50%)")).toBe(128 << 24);
		expect(codeOf(() => colorToArgb("#12"))).toBe("E_ORBIT_INVALID_COLOR");
		expect(codeOf(() => colorToArgb("#zzz"))).toBe("E_ORBIT_INVALID_COLOR");
		expect(codeOf(() => colorToArgb("rgb(1, 2)"))).toBe(
			"E_ORBIT_INVALID_COLOR",
		);
		expect(codeOf(() => colorToArgb("rgb(a, b, c)"))).toBe(
			"E_ORBIT_INVALID_COLOR",
		);
	});
});
