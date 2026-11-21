import { html } from "@c9up/aurora/core";
import { describe, expect, it } from "vitest";
import {
	colorScheme,
	NATIVE_MODULE_NAME,
	OrbitError,
} from "../../src/index.js";
import { APP_NAME, run } from "../../src/react-native/index.js";
import { FakeHost } from "./fakeHost.js";
import { modules, registered, setScheme } from "./reactNative.js";

describe("run", () => {
	it("registers the app the generated activity starts, and mounts it with the launch props", () => {
		const host = new FakeHost();
		modules.set(NATIVE_MODULE_NAME, host);
		run(
			(props) => html`<div class="p-4"><p>${String(props.greeting)}</p></div>`,
		);
		const start = registered.get(APP_NAME);
		expect(start).toBeTypeOf("function");
		start?.({ initialProps: { greeting: "salut" } });
		expect(host.viewport).toEqual([360, 640]);
		const texts = host.all("RCTText").map(([tag]) => host.text(tag));
		expect(texts).toEqual(["salut"]);
	});

	it("refuses a module that is not orbit's host", () => {
		modules.set(NATIVE_MODULE_NAME, { commit() {} });
		run(() => html`<div></div>`);
		expect(() => registered.get(APP_NAME)?.({})).toThrow(OrbitError);
	});

	it("follows the phone's light / dark setting until the app chooses", () => {
		setScheme("dark");
		modules.set(NATIVE_MODULE_NAME, new FakeHost());
		run(() => html`<p>x</p>`);
		registered.get(APP_NAME)?.({});
		expect(colorScheme()).toBe("dark");
		setScheme("light");
		expect(colorScheme()).toBe("light");
		// The app's own choice wins from then on.
		colorScheme("dark");
		setScheme("light");
		expect(colorScheme()).toBe("dark");
	});

	it("keeps the scheme run() was given, whatever the phone says", () => {
		setScheme("dark");
		modules.set(NATIVE_MODULE_NAME, new FakeHost());
		run(() => html`<p>x</p>`, { colorScheme: "light" });
		registered.get(APP_NAME)?.({});
		expect(colorScheme()).toBe("light");
		setScheme("dark");
		expect(colorScheme()).toBe("light");
		setScheme("light");
	});
});
