/**
 * Server-driven pages: photon's router on the phone, its pages as screens.
 * The server here is a table of page objects behind a stubbed fetch, as the
 * ream server answers a visit (`X-Photon`).
 */
import { html } from "@c9up/aurora/core";
import type { TemplateResult } from "@c9up/aurora/renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import table from "../styles/table.json" with { type: "json" };
import { FakeHost } from "./fakeHost.js";

const SERVER = "https://app.example";
const viewport = { width: 400, height: 800 };

type Answer = (init: RequestInit) => Response;

function page(
	component: string,
	url: string,
	props: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	return {
		component,
		props,
		url,
		version: "v1",
		framework: "aurora",
		...extra,
	};
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json", ...headers },
	});
}

interface Request {
	url: string;
	method: string;
	headers: Record<string, string>;
	credentials: RequestCredentials | undefined;
}

/** The server: answers by path, and records what it was asked. */
function server(answers: Record<string, Answer>) {
	const requests: Request[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const headers: Record<string, string> = {};
			new Headers(init.headers).forEach((value, key) => {
				headers[key] = value;
			});
			requests.push({
				url,
				method: init.method ?? "GET",
				headers,
				credentials: init.credentials,
			});
			const answer = answers[new URL(url).pathname];
			return answer ? answer(init) : new Response("", { status: 404 });
		}),
	);
	return requests;
}

/** Let the router's requests and promises settle, then commit. */
async function settle(root: { flush(): void }): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	root.flush();
	for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
	root.flush();
}

const Home = (props: Record<string, unknown>): TemplateResult =>
	html`<div>
		<p>home ${String(props.n)}</p>
		<a href="/orders"><div class="p-4"><p>to orders</p></div></a>
	</div>`;
const Orders = (props: Record<string, unknown>): TemplateResult =>
	html`<div class="flex">
		<p>orders ${JSON.stringify(props.ids)}</p>
		<a href="https://elsewhere.example/help">help</a>
	</div>`;

async function load() {
	// photon's router keeps its state per module: each test boots a fresh one.
	vi.resetModules();
	const orbit = await import("../../src/index.js");
	const pages = await import("../../src/pages.js");
	const host = new FakeHost();
	orbit.useHost(host);
	orbit.useStyles(table);
	return { orbit, pages, host };
}

/** The texts on screen, in drawing order. */
function texts(host: FakeHost): string[] {
	return host
		.all("RCTText")
		.map(([tag]) => host.text(tag))
		.filter((text) => text !== "");
}

/** Press the pressable node whose text contains `label`. */
function press(host: FakeHost, label: string): void {
	const pressable = [...host.all("RCTView"), ...host.all("RCTText")].find(
		([tag, node]) =>
			node.props.gestures === 1 && host.text(tag).includes(label),
	);
	if (!pressable) throw new Error(`nothing pressable reads "${label}"`);
	host.handler?.(pressable[0], "topPress", 0, 0, "{}");
}

beforeEach(() => {
	vi.useRealTimers();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("server-driven pages", () => {
	it("boots from the server, follows a link as a visit, and goes back without a request", async () => {
		const requests = server({
			"/": () => json(page("Home", "/", { n: 1 })),
			"/orders": () => json(page("Orders", "/orders", { ids: [7] })),
		});
		const { orbit, pages, host } = await load();
		const opened: string[] = [];
		const stack = pages.serverPages({
			server: SERVER,
			pages: { Home, Orders },
			stack: { transition: "none" },
			open: (url) => opened.push(url),
		});
		const root = orbit.mount(html`${stack}`, { viewport });
		await settle(root);

		expect(texts(host)).toEqual(["home 1", "to orders"]);
		expect(requests[0]).toMatchObject({
			url: `${SERVER}/`,
			headers: { "x-photon": "true" },
			credentials: "include",
		});

		// A link wrapping blocks is a pressable view; the press is a visit.
		press(host, "to orders");
		await settle(root);
		expect(requests.at(-1)).toMatchObject({
			url: `${SERVER}/orders`,
			headers: { "x-photon": "true", "x-photon-version": "v1" },
		});
		expect(texts(host)).toEqual(["home 1", "to orders", "orders [7]", "help"]);
		expect(stack.canGoBack()).toBe(true);

		// A link off the server goes to the platform, not to the server.
		const asked = requests.length;
		press(host, "help");
		expect(opened).toEqual(["https://elsewhere.example/help"]);
		expect(requests.length).toBe(asked);

		// Back goes through photon's history: the covered page comes back as it was.
		expect(stack.back()).toBe(true);
		await settle(root);
		expect(texts(host)).toEqual(["home 1", "to orders"]);
		expect(requests.length).toBe(asked);
		expect(stack.back()).toBe(false);
	});

	it("reloads a page in place, and starts again from the server on a stale version", async () => {
		let version = "v1";
		const requests = server({
			"/": () => json(page("Home", "/", { n: 1 })),
			// As photon's middleware: a visit carrying an older version gets a 409.
			"/orders": (init) =>
				(new Headers(init.headers).get("x-photon-version") ?? version) !==
				version
					? new Response("", {
							status: 409,
							headers: { "x-photon-location": `${SERVER}/orders` },
						})
					: json(page("Orders", "/orders", { ids: [version] }, { version })),
		});
		const { orbit, pages, host } = await load();
		const stack = pages.serverPages({
			server: SERVER,
			pages: { Home, Orders },
			stack: { transition: "none" },
		});
		const root = orbit.mount(html`${stack}`, { viewport });
		await settle(root);
		const { router } = await import("@c9up/photon/client/core");

		await router.visit("/orders");
		await settle(root);
		expect(texts(host)).toEqual([
			"home 1",
			"to orders",
			'orders ["v1"]',
			"help",
		]);

		// The same address again: the page is replaced where it is, not stacked.
		await router.reload();
		await settle(root);
		expect(texts(host)).toEqual([
			"home 1",
			"to orders",
			'orders ["v1"]',
			"help",
		]);
		expect(stack.canGoBack()).toBe(true);

		// The server was deployed again: 409, and the phone starts from that page.
		version = "v2";
		const before = requests.length;
		await router.visit("/orders");
		await settle(root);
		expect(requests.length).toBe(before + 2);
		expect(texts(host)).toEqual(['orders ["v2"]', "help"]);
		expect(stack.canGoBack()).toBe(false);
	});

	it("sends the XSRF token the server set back on a mutation", async () => {
		const requests = server({
			"/": () =>
				json(page("Home", "/", { n: 1 }), {
					"set-cookie": "session=abc; HttpOnly, XSRF-TOKEN=t%2B1; Path=/",
				}),
			"/orders": () => json(page("Orders", "/orders", { ids: [] })),
		});
		const { orbit, pages } = await load();
		const root = orbit.mount(
			html`${pages.serverPages({ server: SERVER, pages: { Home, Orders } })}`,
			{ viewport },
		);
		await settle(root);
		const { router } = await import("@c9up/photon/client/core");
		await router.put("/orders", { n: 2 });
		expect(requests.at(-1)).toMatchObject({
			method: "PUT",
			// Verbatim: the server compares the header to the cookie byte for byte.
			headers: { "x-xsrf-token": "t%2B1" },
		});
	});

	it("shows what failed when the server names a page the app does not have, and retries", async () => {
		let component = "Missing";
		server({ "/": () => json(page(component, "/", { n: 3 })) });
		const { orbit, pages, host } = await load();
		const root = orbit.mount(
			html`${pages.serverPages({ server: SERVER, pages: { Home } })}`,
			{ viewport },
		);
		await settle(root);
		expect(texts(host).join(" ")).toContain('the page "Missing"');

		component = "Home";
		press(host, "Retry");
		await settle(root);
		expect(texts(host)).toEqual(["home 3", "to orders"]);
	});

	it("refuses a server over plain http, unless it is this machine or the emulator's host", async () => {
		const { pages } = await load();
		server({});
		expect(() =>
			pages.serverPages({ server: "http://app.example", pages: {} }),
		).toThrow(expect.objectContaining({ code: "E_ORBIT_INSECURE_SERVER" }));
		expect(() =>
			pages.serverPages({ server: "http://10.0.2.2:3333", pages: {} }),
		).not.toThrow();
	});
});

describe("links", () => {
	it("makes a link in a block its own touch target, and leaves one in a sentence inert", async () => {
		const { orbit, host } = await load();
		const followed: string[] = [];
		const template = await import("../../src/template.js");
		template.setLinkHandler((href) => followed.push(href));
		orbit.mount(
			html`<main>
				<nav><a href="/orders">Orders</a> <a href="/about">About</a></nav>
				<ul><li><a href="/orders/1">First</a></li></ul>
				<p>Read <a href="/terms">the terms</a> first.</p>
			</main>`,
			{ viewport },
		);
		press(host, "Orders");
		press(host, "About");
		press(host, "First");
		expect(followed).toEqual(["/orders", "/about", "/orders/1"]);
		expect(texts(host)).toContain("Read the terms first.");
		expect(() => press(host, "the terms")).toThrow(/nothing pressable/);
	});
});
