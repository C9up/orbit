import { each, html, signal } from "@c9up/aurora/core";
import { describe, expect, it } from "vitest";
import { mount, useHost } from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

// The fake lays out a column: the scroll view is the viewport's 800 tall.
const viewport = { width: 400, height: 800 };

type Row = { id: number; tall: boolean };

const rows = (count: number, tall = false): Row[] =>
	Array.from({ length: count }, (_, id) => ({ id, tall }));

/** Let commits, the list's measures and the fake's scroll reports settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function setup(
	items: () => readonly Row[],
	options: { estimate?: number; from?: "start" | "end" } = {},
) {
	const host = new FakeHost();
	useHost(host);
	const root = mount(
		html`<div class="flex-1 overflow-y-auto">${each(
			items,
			(row) => row.id,
			(row, index) =>
				html`<div class=${() => (row().tall ? "h-25" : "h-10")}><p>${() => `#${index()}`}</p></div>`,
			{
				lazy: {
					estimate: options.estimate ?? 40,
					overscan: 200,
					from: options.from,
				},
			},
		)}</div>`,
		{ viewport },
	);
	const [scrollTag] = host.all("RCTScrollView")[0] ?? [];
	if (scrollTag === undefined) throw new Error("no scroll view");
	return { host, root, scrollTag };
}

/** The rows the host shows, as the index each one prints. */
function shown(host: FakeHost): number[] {
	return host
		.all("RCTText")
		.map(([tag]) => host.text(tag))
		.filter((text) => text.startsWith("#"))
		.map((text) => Number(text.slice(1)))
		.sort((a, b) => a - b);
}

/** The row under the viewport's top edge, and how far below the edge it starts. */
function topRow(
	host: FakeHost,
	scrollTag: number,
): { index: number; offset: number } {
	const offset = host.offsets.get(scrollTag) ?? 0;
	const texts = host
		.all("RCTText")
		.filter(([tag]) => host.text(tag).startsWith("#"));
	const frames: unknown = JSON.parse(
		host.layout(
			JSON.stringify(
				texts.map(([tag]) => {
					for (const [parent, node] of host.nodes)
						if (node.children.includes(tag)) return parent;
					return -1;
				}),
			),
		),
	);
	const list = Array.isArray(frames) ? frames : [];
	let best: { index: number; offset: number } | null = null;
	texts.forEach(([tag], i) => {
		const frame: unknown = list[i];
		if (!Array.isArray(frame)) return;
		const [, y, , h] = frame;
		if (typeof y !== "number" || typeof h !== "number") return;
		if (y + h > offset && (best === null || y - offset < best.offset))
			best = { index: Number(host.text(tag).slice(1)), offset: y - offset };
	});
	if (best === null) throw new Error("no row in view");
	return best;
}

describe("lazy each", () => {
	it("mounts only the rows in view out of 10 000", async () => {
		const items = signal(rows(10_000));
		const { host } = setup(items);
		await settle();
		// 800 of viewport and 200 of overscan below, rows of 40: 25 rows.
		expect(shown(host)).toHaveLength(25);
		expect(shown(host)[0]).toBe(0);
		// Created views: the window's rows, never the 10 000.
		expect(host.all("RCTView").length).toBeLessThan(40);
	});

	it("follows the scroll offset, with spacers standing for the rest", async () => {
		const items = signal(rows(10_000));
		const { host, scrollTag } = setup(items);
		await settle();
		host.scrollTo(scrollTag, 200_000);
		await settle();
		const ids = shown(host);
		expect(ids).toContain(5000);
		expect(ids.length).toBeLessThanOrEqual(31);
		expect(topRow(host, scrollTag)).toEqual({ index: 5000, offset: 0 });
	});

	it("keeps the row on screen in place when measures correct the estimate", async () => {
		// Rows of 100 estimated 40: every row measured moves the ones below it.
		const items = signal(rows(2000, true));
		const { host, scrollTag } = setup(items, { estimate: 40 });
		await settle();
		host.scrollTo(scrollTag, 30_000);
		await settle();
		const before = topRow(host, scrollTag);
		// Scrolling up through rows never measured: corrections above the viewport.
		for (let i = 0; i < 5; i++) {
			host.scrollTo(scrollTag, (host.offsets.get(scrollTag) ?? 0) - 300);
			await settle();
		}
		const after = topRow(host, scrollTag);
		expect(before.index - after.index).toBeGreaterThanOrEqual(14);
		expect(before.index - after.index).toBeLessThanOrEqual(16);
		expect(host.scrolls.some(([, by, toEnd]) => !toEnd && by !== 0)).toBe(true);
	});

	it("starts a conversation at its end and stays there as messages arrive", async () => {
		const items = signal(rows(5000));
		const { host, scrollTag } = setup(items, { from: "end" });
		await settle();
		expect(shown(host)).toContain(4999);
		expect(host.scrolls.some(([, , toEnd]) => toEnd)).toBe(true);
		const atEnd = () => {
			const { index, offset } = topRow(host, scrollTag);
			return { index, offset };
		};
		const first = atEnd();
		items((all) => [...all, { id: 5000, tall: false }]);
		await settle();
		expect(shown(host)).toContain(5000);
		// One more row of 40 at the end: the view moved down by one row.
		expect(atEnd().index).toBe(first.index + 1);
	});
});
