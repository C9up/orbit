import { each, effect, html, signal } from "@c9up/aurora/core";
import { describe, expect, it } from "vitest";
import { errors, mount, useHost } from "../../src/index.js";
import { FakeHost, type Op } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

type Row = { id: number; name: string };

function setup() {
	const host = new FakeHost();
	useHost(host);
	const rows = signal<readonly Row[]>([
		{ id: 1, name: "un" },
		{ id: 2, name: "deux" },
		{ id: 3, name: "trois" },
	]);
	let renders = 0;
	const root = mount(
		html`<div class="flex-col">${each(
			rows,
			(row) => row.id,
			(row, index) => {
				renders++;
				return html`<div class="p-2"><p>${() => `${index()}:${row().name}`}</p></div>`;
			},
		)}</div>`,
		{ viewport },
	);
	return { host, rows, root, renders: () => renders };
}

/** The list's row views, in on-screen order, with the text each shows. */
function shown(host: FakeHost): Array<[number, string]> {
	const list = host
		.all("RCTView")
		.find(([, node]) =>
			node.children.some((child) => host.nodes.get(child)?.props.padding === 8),
		);
	if (!list) return [];
	return list[1].children.map((tag) => {
		const text = host.nodes.get(tag)?.children[0] ?? -1;
		return [tag, host.text(text)];
	});
}

const created = (batch: Op[] | undefined) =>
	(batch ?? []).filter(([code]) => code === "c").length;

describe("each", () => {
	it("moves rows when the order changes: no view is created or deleted", async () => {
		const { host, rows, root, renders } = setup();
		const before = shown(host);
		expect(before.map(([, text]) => text)).toEqual([
			"0:un",
			"1:deux",
			"2:trois",
		]);
		rows((list) => [...list].reverse());
		await Promise.resolve();
		const after = shown(host);
		expect(after.map(([tag]) => tag)).toEqual(
			before.map(([tag]) => tag).reverse(),
		);
		// Each row sees its new position through its accessor.
		expect(after.map(([, text]) => text)).toEqual([
			"0:trois",
			"1:deux",
			"2:un",
		]);
		expect(created(host.batches.at(-1))).toBe(0);
		expect(root.reports.at(-1)?.deleted).toEqual([]);
		expect(renders()).toBe(3);
	});

	it("builds one row for an insert and deletes one for a removal", async () => {
		const { host, rows, root, renders } = setup();
		rows((list) => [list[0] as Row, { id: 9, name: "neuf" }, ...list.slice(1)]);
		await Promise.resolve();
		// The row's view, its text and the text's raw run.
		expect(created(host.batches.at(-1))).toBe(3);
		expect(renders()).toBe(4);
		expect(shown(host).map(([, text]) => text)).toEqual([
			"0:un",
			"1:neuf",
			"2:deux",
			"3:trois",
		]);
		const [, nine] = shown(host)[1] ?? [];
		expect(nine).toBe("1:neuf");
		const gone = shown(host)[1]?.[0];
		rows((list) => list.filter((row) => row.id !== 9));
		await Promise.resolve();
		expect(created(host.batches.at(-1))).toBe(0);
		expect(root.reports.at(-1)?.deleted).toContain(gone);
		expect(shown(host)).toHaveLength(3);
	});

	it("updates a kept row in place when its element changes", async () => {
		const { host, rows, renders } = setup();
		rows((list) =>
			list.map((row) => (row.id === 2 ? { ...row, name: "DEUX" } : row)),
		);
		await Promise.resolve();
		expect(shown(host)[1]?.[1]).toBe("1:DEUX");
		expect(created(host.batches.at(-1))).toBe(0);
		expect(renders()).toBe(3);
	});

	it("refuses two elements with the same key", () => {
		const host = new FakeHost();
		useHost(host);
		const twice = [
			{ id: 1, name: "a" },
			{ id: 1, name: "b" },
		];
		const run = () =>
			mount(
				html`<div>${each(
					twice,
					(row) => row.id,
					(row) => html`<p>${() => row().name}</p>`,
				)}</div>`,
				{ viewport },
			);
		expect(run).toThrow(errors.E_ORBIT_DUPLICATE_KEY);
		try {
			run();
		} catch (error) {
			expect(error).toMatchObject({ code: "E_ORBIT_DUPLICATE_KEY" });
		}
	});
});

describe("a reactive slot", () => {
	it("runs a component it shows once, and ends its effects when it goes", async () => {
		const host = new FakeHost();
		useHost(host);
		const shown = signal(true);
		const count = signal(0);
		let setups = 0;
		let runs = 0;
		const Badge = () => {
			setups++;
			effect(() => {
				count();
				runs++;
			});
			return html`<div class="p-1"></div>`;
		};
		mount(html`<div>${() => (shown() ? Badge() : "")}</div>`, { viewport });
		expect(setups).toBe(1);
		runs = 0;
		count(1);
		expect(runs).toBe(1);
		shown(false);
		await Promise.resolve();
		runs = 0;
		count(2);
		expect(runs).toBe(0);
	});
});
