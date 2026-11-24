import { html, signal } from "@c9up/aurora/core";
import { describe, expect, it } from "vitest";
import { colorToArgb, mount, useHost } from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

function setup(): FakeHost {
	const host = new FakeHost();
	useHost(host);
	return host;
}

function field(host: FakeHost) {
	const entry = host.all("OrbitTextInput")[0];
	if (!entry) throw new Error("no text field");
	const [tag, node] = entry;
	const send = (type: string, text: string) =>
		host.handler?.(tag, type, 0, 0, text);
	return { tag, node, send };
}

describe("text fields", () => {
	it("maps an input with its attributes, classes and inherited text style", () => {
		const host = setup();
		mount(
			html`<div class="text-slate-800"><input type="email" placeholder="Adresse" maxlength="64" class="p-3 rounded-lg bg-white text-base" /></div>`,
			{ viewport },
		);
		const { node } = field(host);
		expect(node.props).toMatchObject({
			placeholder: "Adresse",
			keyboard: "email",
			maxLength: 64,
			multiline: false,
			rows: 1,
			secure: false,
			editable: true,
			padding: 12,
			// Tailwind v4's slate-800, and the theme's --radius (0.625rem).
			borderRadius: 10,
			fontSize: 16,
			color: colorToArgb("#1d293d"),
			// Tailwind's preflight: the text colour at half strength.
			placeholderColor: colorToArgb("rgba(29, 41, 61, 0.5)"),
			text: "",
		});
	});

	it("maps a textarea, a password and a disabled field", () => {
		const host = setup();
		mount(
			html`<div><textarea rows="4"></textarea><input type="password" disabled /></div>`,
			{ viewport },
		);
		const [area, password] = host.all("OrbitTextInput").map(([, n]) => n);
		expect(area?.props).toMatchObject({ multiline: true, rows: 4 });
		expect(password?.props).toMatchObject({ secure: true, editable: false });
	});

	it("reports typing through @input, and @change on blur when the text changed", () => {
		const host = setup();
		const seen: string[] = [];
		const draft = signal("");
		mount(
			html`<input .value=${draft} @input=${(e: { target: { value: string } }) => draft(e.target.value)} @change=${(e: { target: { value: string } }) => seen.push(`change:${e.target.value}`)} @focus=${() => seen.push("focus")} @blur=${() => seen.push("blur")} />`,
			{ viewport },
		);
		const { send } = field(host);
		send("topFocus", "");
		send("topChange", "Sal");
		send("topChange", "Salut");
		send("topBlur", "Salut");
		expect(draft()).toBe("Salut");
		expect(seen).toEqual(["focus", "change:Salut", "blur"]);
	});

	it("does not send back the text the field just reported (the caret stays put)", async () => {
		const host = setup();
		const draft = signal("");
		mount(
			html`<input .value=${draft} @input=${(e: { target: { value: string } }) => draft(e.target.value)} />`,
			{
				viewport,
			},
		);
		const { send } = field(host);
		send("topChange", "abc");
		await Promise.resolve();
		expect(host.batches).toHaveLength(1);
	});

	it("sends a value the app sets, with a new version, e.g. clearing after send", async () => {
		const host = setup();
		const draft = signal("");
		mount(
			html`<input .value=${draft} @input=${(e: { target: { value: string } }) => draft(e.target.value)} />`,
			{
				viewport,
			},
		);
		const { tag, send } = field(host);
		send("topChange", "message");
		draft("");
		await Promise.resolve();
		expect(host.batches.at(-1)).toEqual([
			["u", tag, { text: "", textVersion: 1 }],
		]);
	});

	it("grows a textarea sized by its content: the host measures what it holds", async () => {
		const host = setup();
		mount(
			html`<textarea rows="1" class="field-sizing-content max-h-32"></textarea>`,
			{ viewport },
		);
		const { tag, node, send } = field(host);
		expect(node.props).toMatchObject({
			multiline: true,
			rows: 1,
			fieldSizing: "content",
			maxHeight: 128,
		});

		send("topChange", "une\ndeux");
		await Promise.resolve();

		// Layout only: the field already shows the text, it is not sent back.
		expect(host.batches.at(-1)).toEqual([
			["u", tag, { measureText: "une\ndeux" }],
		]);
	});

	it("turns the keyboard's submit into @keydown Enter", () => {
		const host = setup();
		const keys: string[] = [];
		mount(
			html`<input @keydown=${(e: { key: string }) => keys.push(e.key)} />`,
			{ viewport },
		);
		field(host).send("topSubmit", "x");
		expect(keys).toEqual(["Enter"]);
	});

	it("lays out again when the window resizes (the keyboard)", () => {
		const host = setup();
		mount(html`<div class="flex-1"><input /></div>`, { viewport });
		host.handler?.(0, "topViewport", 400, 500, "");
		expect(host.viewport).toEqual([400, 500]);
		expect(host.batches).toHaveLength(2);
	});

	it("shrinks back a field sized by its content when the app clears it", async () => {
		const host = setup();
		const draft = signal("");
		mount(
			html`<textarea class="field-sizing-content" .value=${draft} @input=${(e: { target: { value: string } }) => draft(e.target.value)}></textarea>`,
			{ viewport },
		);
		const { tag, send } = field(host);
		send("topChange", "une\ndeux");
		await Promise.resolve();
		draft("");
		await Promise.resolve();
		expect(host.batches.at(-1)).toEqual([
			["u", tag, { text: "", textVersion: 1, measureText: "" }],
		]);
	});

	it("sends a value longer than maxlength whole, with the limit: the field keeps it, as HTML does", async () => {
		const host = setup();
		const name = signal("Ana");
		const long = "Maximilienne-Alexandrine B"; // 26 units, from another client
		mount(
			html`<div>
				<input maxlength="20" value=${long} />
				<textarea maxlength="20" .value=${() => name()}></textarea>
			</div>`,
			{ viewport },
		);
		const [first, second] = host
			.all("OrbitTextInput")
			.map(([, node]) => node.props);
		expect(first).toMatchObject({ maxLength: 20, text: long, textVersion: 0 });
		name(long);
		await Promise.resolve();
		expect(second).toMatchObject({ maxLength: 20, text: long, textVersion: 1 });
	});
});
