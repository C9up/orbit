import { html, signal } from "@c9up/aurora/core";
import { describe, expect, it } from "vitest";
import {
	colorToArgb,
	MotionValue,
	mount,
	OrbitError,
	unknownClasses,
	useHost,
} from "../../src/index.js";
import { tw } from "../../src/tailwind.js";
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
		if (error instanceof OrbitError) return error.code;
		throw error;
	}
	return "none";
}

describe("tailwind subset", () => {
	it("splits box and text props, with the utilities orbit reads", () => {
		const s = tw(
			"p-4 px-2 mt-1 gap-3 w-16 h-2 rounded-lg font-semibold text-xl text-white bg-violet-500 border border-white/30 items-center justify-between self-start",
		);
		expect(s.box).toMatchObject({
			padding: 16,
			paddingHorizontal: 8,
			marginTop: 4,
			gap: 12,
			width: 64,
			height: 8,
			borderRadius: 8,
			backgroundColor: "#8b5cf6",
			borderWidth: 1,
			borderColor: "rgba(255, 255, 255, 0.3)",
			alignItems: "center",
			justifyContent: "space-between",
			alignSelf: "flex-start",
		});
		expect(s.text).toEqual({
			fontWeight: "600",
			fontSize: 20,
			color: "#ffffff",
		});
	});

	it("reads shadows, backdrop blur, positions and translucent colours", () => {
		expect(tw("shadow-lg").box).toEqual({
			shadowY: 10,
			shadowBlur: 15,
			shadowSpread: -3,
			shadowColor: "rgba(0, 0, 0, 0.1)",
		});
		expect(tw("shadow").box).toMatchObject({ shadowBlur: 3 });
		expect(tw("backdrop-blur-xl").box).toEqual({ backdropBlur: 24 });
		expect(tw("backdrop-blur").box).toEqual({ backdropBlur: 8 });
		expect(tw("absolute top-0 left-4 inset-x-0").box).toMatchObject({
			position: "absolute",
			top: 0,
			left: 0,
			right: 0,
		});
		expect(tw("text-white/80").text).toEqual({
			color: "rgba(255, 255, 255, 0.8)",
		});
		expect(tw("bg-slate-900/40").box).toEqual({
			backgroundColor: "rgba(15, 23, 42, 0.4)",
		});
	});

	it("collects classes it does not know, and ignores colours it has no shade for", () => {
		tw("grid-cols-3 bg-teal-500 bg-nope-500/50");
		expect(unknownClasses.has("grid-cols-3")).toBe(true);
		expect(unknownClasses.has("bg-teal-500")).toBe(true);
		expect(unknownClasses.has("bg-nope-500/50")).toBe(true);
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
		expect(patch?.[2]).toMatchObject({ color: colorToArgb("#16a34a") });
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
