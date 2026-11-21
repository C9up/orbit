import { component, html } from "@c9up/aurora/core";
import { describe, expect, it, vi } from "vitest";
import {
	createStack,
	NATIVE_MODULE_NAME,
	type Screen,
	useScreen,
} from "../../src/index.js";
import { APP_NAME, run } from "../../src/react-native/index.js";
import { FakeHost } from "./fakeHost.js";
import { back, modules, registered } from "./reactNative.js";

/** The texts the host shows now. */
function texts(host: FakeHost): string[] {
	return host.all("RCTText").map(([tag]) => host.text(tag));
}

describe("the back button", () => {
	it("pops the innermost shown stack, then leaves the app to the platform", async () => {
		vi.useFakeTimers();
		const host = new FakeHost();
		modules.set(NATIVE_MODULE_NAME, host);
		const handles: { [name: string]: Screen } = {};
		const Page = component((props: { name: string }) => {
			handles[props.name] = useScreen();
			return html`<p>${props.name}</p>`;
		});
		// A screen holding a stack of its own (a tab with its own history).
		const Tab = component(() => {
			handles.tab = useScreen();
			return html`${createStack(Page, { props: { name: "inner" } })}`;
		});
		run(() => html`${createStack(Tab)}`);
		registered.get(APP_NAME)?.({});

		handles.inner?.push(Page, { name: "inner detail" });
		await Promise.resolve();
		expect(texts(host)).toEqual(["inner", "inner detail"]);

		// The inner stack goes back first.
		expect(back()).toBe(true);
		vi.advanceTimersByTime(300);
		await Promise.resolve();
		expect(texts(host)).toEqual(["inner"]);

		// Cover the tab: its stack is not shown, so back pops the outer one.
		handles.inner?.push(Page, { name: "inner again" });
		handles.tab?.push(Page, { name: "outer detail" });
		expect(handles["inner again"]?.focused()).toBe(false);
		expect(back()).toBe(true);
		expect(handles.tab?.focused()).toBe(true);
		expect(handles["inner again"]?.focused()).toBe(true);
		expect(back()).toBe(true);
		expect(handles.inner?.focused()).toBe(true);

		// Nothing left to pop: the platform's own back (leave the app).
		expect(back()).toBe(false);
		vi.useRealTimers();
	});
});
