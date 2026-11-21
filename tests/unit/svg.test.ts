import { html, signal } from "@c9up/aurora/core";
import { describe, expect, it } from "vitest";
import { colorToArgb, mount, OrbitError, useHost } from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

function setup(): FakeHost {
	const host = new FakeHost();
	useHost(host);
	return host;
}

function vectorOf(host: FakeHost) {
	const entry = host.all("OrbitVector")[0];
	if (!entry) throw new Error("no vector");
	return entry;
}

/** nebula's icon wrapper, as nebula writes it (src/lib/icons.ts). */
const icon = (body: unknown, cls?: string) => html`<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class="${cls}"
	aria-hidden="${"true"}"
>${body}</svg>`;

describe("svg", () => {
	it("describes the drawing to the host, through the slots that hold its shapes", () => {
		const host = setup();
		mount(
			html`<div class="text-slate-500">${icon(html`<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />`, "size-6")}</div>`,
			{ viewport },
		);
		const [, node] = vectorOf(host);
		expect(node.props).toMatchObject({ width: 24, height: 24 });
		expect(node.props.vector).toEqual({
			color: colorToArgb("#64748b"),
			root: {
				t: "svg",
				a: {
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					"stroke-width": "2",
					"stroke-linecap": "round",
					"stroke-linejoin": "round",
				},
				c: [
					{ t: "circle", a: { cx: "11", cy: "11", r: "8" }, c: [] },
					{ t: "path", a: { d: "m21 21-4.3-4.3" }, c: [] },
				],
			},
		});
	});

	it("sizes from width and height, else keeps the viewBox's proportions", () => {
		const host = setup();
		mount(
			html`<div><svg width="48" height="32px" viewBox="0 0 3 2"><rect width="3" height="2" fill="#ff0000" /></svg><svg viewBox="0 0 4 1"><line x1="0" y1="0" x2="4" y2="1" stroke="#000" /></svg></div>`,
			{ viewport },
		);
		const [first, second] = host.all("OrbitVector").map(([, n]) => n.props);
		expect(first).toMatchObject({ width: 48, height: 32 });
		expect(first?.aspectRatio).toBeUndefined();
		expect(first?.vector).toMatchObject({
			root: { c: [{ t: "rect", a: { fill: colorToArgb("#ff0000") } }] },
		});
		expect(second).toMatchObject({ aspectRatio: 4 });
	});

	it("sends a new drawing when what it reads changes", () => {
		const host = setup();
		const done = signal(false);
		const root = mount(
			html`<div class="text-slate-900">${icon(() => (done() ? html`<path d="M20 6 9 17l-5-5" />` : html`<circle cx="12" cy="12" r="10" />`), "size-4")}</div>`,
			{ viewport },
		);
		const [tag] = vectorOf(host);
		done(true);
		root.flush();
		const update = host.batches
			.at(-1)
			?.find(([code, t]) => code === "u" && t === tag);
		expect(JSON.stringify(update)).toContain("M20 6 9 17l-5-5");
	});

	it("refuses what the host does not draw", () => {
		setup();
		expect(() =>
			mount(html`<svg viewBox="0 0 10 10"><text x="0" y="5">a</text></svg>`, {
				viewport,
			}),
		).toThrowError(OrbitError);
		expect(() =>
			mount(
				html`<svg viewBox="0 0 10 10"><path fill="papayawhip" d="M0 0" /></svg>`,
				{
					viewport,
				},
			),
		).toThrowError(OrbitError);
	});
});
