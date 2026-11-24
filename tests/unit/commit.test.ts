import { each, html, signal } from "@c9up/aurora/core";
import { afterEach, describe, expect, it } from "vitest";
import { serialise, toWellFormed } from "../../src/commit.js";
import { errors, mount, useHost } from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (typeof value === "object" && value !== null)
		for (const v of Object.values(value)) strings(v, out);
	return out;
}

/**
 * Refuses what orbit-host refuses: its JSON reader fails on a `\udXXX` escape
 * that is not half of a pair, applies nothing of the batch, and the native
 * module throws the `{"error": …}` report as a JS error.
 */
class StrictHost extends FakeHost {
	refused = 0;
	override commit(json: string): string {
		if (strings(JSON.parse(json)).some((s) => toWellFormed(s) !== s)) {
			this.refused += 1;
			throw new Error(
				'{"error":"unexpected end of hex escape at line 1 column 38"}',
			);
		}
		return super.commit(json);
	}
}

/** Refuses the next `refuse` batches, before (`whole`) or after applying them. */
class RefusingHost extends FakeHost {
	refuse = 0;
	applyFirst = false;
	error = '{"error":"the host refused"}';
	override commit(json: string): string {
		if (this.refuse > 0) {
			this.refuse -= 1;
			if (this.applyFirst) super.commit(json);
			throw new Error(this.error);
		}
		return super.commit(json);
	}
}

function codeOf(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return Reflect.get(Object(error), "code");
	}
	return undefined;
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "__DEV__");
});

describe("strings sent to the host", () => {
	it("replaces each unpaired surrogate with U+FFFD and keeps pairs", () => {
		expect(toWellFormed("Ana\u{1f600}")).toBe("Ana\u{1f600}");
		expect(toWellFormed("Ana\u{1f600}".slice(0, 4))).toBe("Ana�");
		expect(toWellFormed("\udc00x\ud83d")).toBe("�x�");
		expect(toWellFormed("\ud83d😀")).toBe("�\u{1f600}");
		expect(toWellFormed("plain")).toBe("plain");
		expect(toWellFormed("")).toBe("");
	});

	it("serialises a batch without any lone surrogate escape", () => {
		const ops = [["c", 2, "RCTRawText", { text: "x\ud83d", alt: "\udc00" }]];
		const json = serialise(ops);
		expect(json).not.toMatch(/\\ud[89a-f]/);
		expect(JSON.parse(json)).toEqual([
			["c", 2, "RCTRawText", { text: "x�", alt: "�" }],
		]);
		// A backslash the text holds is not mistaken for an escape.
		expect(serialise([{ text: "\\ud83d" }])).toBe(
			JSON.stringify([{ text: "\\ud83d" }]),
		);
	});

	it("mounts a name cut in the middle of an emoji, shown with U+FFFD", () => {
		const host = new StrictHost();
		useHost(host);
		const name = "Ana\u{1f600}".slice(0, 4);
		mount(html`<div><p>hello</p><p>${name}</p></div>`, { viewport });
		expect(host.refused).toBe(0);
		const texts = host.all("RCTText").map(([tag]) => host.text(tag));
		expect(texts).toEqual(["hello", "Ana�"]);
	});

	it("patches, placeholders and alt texts are made well formed too", async () => {
		const host = new StrictHost();
		useHost(host);
		const text = signal("ok");
		mount(
			html`<div><p>${() => text()}</p><input placeholder=${"Reply to \ud83d"} /><img src="https://cdn.example/a.png" alt=${"\ud83d"} /></div>`,
			{ viewport },
		);
		text("\udc00y");
		await Promise.resolve();
		expect(host.refused).toBe(0);
		expect(host.all("RCTText").map(([tag]) => host.text(tag))).toEqual(["�y"]);
		expect(host.all("OrbitTextInput")[0]?.[1].props.placeholder).toBe(
			"Reply to �",
		);
		expect(host.all("OrbitImage")[0]?.[1].props.alt).toBe("�");
	});
});

describe("a commit the host refuses", () => {
	it("first mount: throws E_ORBIT_COMMIT_FAILED with the report, and the next commit sends the whole tree", () => {
		const host = new RefusingHost();
		host.refuse = 1;
		useHost(host);
		let root: ReturnType<typeof mount> | undefined;
		let thrown: unknown;
		try {
			root = mount(html`<div><p>hello</p></div>`, { viewport });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(errors.E_ORBIT_COMMIT_FAILED);
		expect(String(Reflect.get(Object(thrown), "message"))).toContain(
			"the host refused",
		);
		expect(host.root).toBe(null);
		expect(root).toBeUndefined();
	});

	it("a refused flush() throws, and the batch goes out again with the next one", () => {
		const host = new RefusingHost();
		useHost(host);
		const label = signal("a");
		const root = mount(html`<div><p>${() => label()}</p></div>`, { viewport });
		label("b");
		host.refuse = 1;
		expect(codeOf(() => root.flush())).toBe("E_ORBIT_COMMIT_FAILED");
		root.flush();
		expect(host.batches.at(-1)).toContainEqual([
			"u",
			expect.any(Number),
			{ text: "b" },
		]);
		expect(host.all("RCTText").map(([tag]) => host.text(tag))).toEqual(["b"]);
	});

	it("running app: the refusal reaches onError, and nothing of the batch is lost", async () => {
		const host = new StrictHost();
		useHost(host);
		const seen: unknown[] = [];
		type Message = { id: number; text: string };
		const messages = signal<readonly Message[]>([{ id: 1, text: "hi" }]);
		const unread = signal(1);
		mount(
			html`<div><p>${() => `${unread()} unread`}</p>${each(
				messages,
				(m) => m.id,
				(m) => html`<p>${() => m().text}</p>`,
			)}</div>`,
			{ viewport, onError: (error) => seen.push(error) },
		);
		const texts = () => host.all("RCTText").map(([tag]) => host.text(tag));
		expect(texts()).toEqual(["1 unread", "hi"]);

		// The host refuses the next batch, whatever it holds: the scheduled commit fails.
		host.commit = (json) => {
			host.commit = StrictHost.prototype.commit.bind(host);
			throw new Error(`{"error":"refused ${json.length}"}`);
		};
		messages((list) => [...list, { id: 2, text: "see you at 8" }]);
		unread(2);
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeInstanceOf(errors.E_ORBIT_COMMIT_FAILED);
		expect(texts()).toEqual(["1 unread", "hi"]);

		// The next change commits the refused one with it.
		unread(3);
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		expect(texts()).toEqual(["3 unread", "hi", "see you at 8"]);
	});

	it("a host that applied part of the batch before refusing gets every walked list again", async () => {
		const host = new RefusingHost();
		useHost(host);
		const seen: unknown[] = [];
		const rows = signal<readonly number[]>([1]);
		mount(
			html`<div>${each(
				rows,
				(n) => n,
				(n) => html`<p>row ${() => String(n())}</p>`,
			)}</div>`,
			{ viewport, onError: (error) => seen.push(error) },
		);
		const texts = () => host.all("RCTText").map(([tag]) => host.text(tag));
		host.refuse = 1;
		host.applyFirst = true;
		rows([1, 2]);
		await Promise.resolve();
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		// The data goes back to what the host had before: the children list the
		// host applied anyway must still be replaced.
		rows([1]);
		await Promise.resolve();
		await Promise.resolve();
		expect(texts()).toEqual(["row 1"]);
	});

	it("a coded host refusal is thrown as its own error", () => {
		const host = new RefusingHost();
		host.refuse = 1;
		host.error =
			'{"error":"E_ORBIT_TREE_TOO_DEEP: the views nest more than 100 levels deep"}';
		useHost(host);
		let thrown: unknown;
		try {
			mount(html`<div></div>`, { viewport });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(errors.E_ORBIT_TREE_TOO_DEEP);
		expect(String(Reflect.get(Object(thrown), "message"))).toBe(
			"[orbit] the views nest more than 100 levels deep",
		);
	});

	it("a host answer that is not a report is E_ORBIT_COMMIT_FAILED", () => {
		const host = new FakeHost();
		host.commit = () => '"not a report"';
		useHost(host);
		expect(codeOf(() => mount(html`<div></div>`, { viewport }))).toBe(
			"E_ORBIT_COMMIT_FAILED",
		);
		host.commit = () => "{not json";
		expect(codeOf(() => mount(html`<div></div>`, { viewport }))).toBe(
			"E_ORBIT_COMMIT_FAILED",
		);
	});

	it("what the host left out of a drawing reaches onError, the commit goes through", () => {
		const host = new FakeHost();
		const commit = host.commit.bind(host);
		host.commit = (json) => {
			const report: unknown = JSON.parse(commit(json));
			return JSON.stringify({
				...Object(report),
				warnings: [
					'E_ORBIT_SVG_VALUE: svg: unreadable number at 9 in d="M0 0 L10 NaN"',
					"an uncoded warning",
				],
			});
		};
		useHost(host);
		const seen: Error[] = [];
		const max = 0;
		mount(
			html`<svg viewBox="0 0 100 50"><rect width="16" height=${(0 / max) * 50} /></svg>`,
			{ viewport, onError: (error) => seen.push(error) },
		);
		const vector = host.all("OrbitVector")[0]?.[1].props.vector;
		// The value goes to the host as written; the host leaves the shape out.
		expect(JSON.stringify(vector)).toContain('"height":"NaN"');
		expect(seen.map((error) => Reflect.get(error, "code"))).toEqual([
			"E_ORBIT_SVG_VALUE",
			"E_ORBIT_SVG_VALUE",
		]);
		expect(seen[0]?.message).toBe(
			'[orbit] svg: unreadable number at 9 in d="M0 0 L10 NaN"',
		);
	});

	it("without onError, a development build logs the refusal and production says nothing", async () => {
		const host = new RefusingHost();
		useHost(host);
		const label = signal("a");
		mount(html`<p>${() => label()}</p>`, { viewport });
		const warned: unknown[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => warned.push(...args);
		try {
			host.refuse = 1;
			label("b");
			await Promise.resolve();
			expect(warned).toEqual([]);
			Reflect.set(globalThis, "__DEV__", true);
			host.refuse = 1;
			label("c");
			await Promise.resolve();
			expect(warned).toHaveLength(1);
			expect(warned[0]).toBeInstanceOf(errors.E_ORBIT_COMMIT_FAILED);
		} finally {
			console.warn = warn;
		}
	});
});
