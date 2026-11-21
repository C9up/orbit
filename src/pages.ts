/**
 * `@c9up/orbit/pages` — pages the ream server drives, on the phone.
 *
 * The server stays the router: a link or a visit asks it for the next page
 * object (photon's protocol, the one the browser speaks after `visits: true`)
 * and the app shows the page it names — an aurora component bundled with the
 * app — as a screen of a stack. The same controller answers the browser and
 * the phone.
 *
 *     run(() => html`${serverPages({
 *       server: 'https://app.example',
 *       pages: { Home, Orders, Order },
 *     })}`)
 *
 * photon's router does the protocol — visits, partial reloads, deferred
 * props, the version check, history — and this is where it runs: requests to
 * the server, a back stack in memory mirrored by the screens, the back button
 * going through photon's history. A covered page keeps its state; going back
 * shows it as it was, without a request.
 */

import { html } from "@c9up/aurora/core";
import type { TemplateResult } from "@c9up/aurora/renderer";
import {
	bootPage,
	type PhotonAdapterHandle,
	type PhotonHost,
	router,
} from "@c9up/photon/client/core";
import { OrbitError } from "./errors.js";
import { createStack, type Stack, type StackOptions } from "./stack.js";
import { setLinkHandler } from "./template.js";

/**
 * A page: an aurora component taking the page object's props. Declared as a
 * method so a page typed with its own props (`{ orders: Order[] }`) is one.
 */
type PageFunction = {
	page(props: Record<string, unknown>): TemplateResult;
}["page"];

export interface ServerPagesOptions {
	/**
	 * The ream server's origin. https, or http to this machine (`localhost`,
	 * `127.0.0.1`, through `adb reverse`) or the emulator's host (`10.0.2.2`).
	 */
	server: string;
	/** The pages the server may name, by the name it renders them under. */
	pages: { [name: string]: PageFunction };
	/** The first page's path. Default `/`. */
	url?: string;
	/** How screens change (`transition`, `duration`, `background`). */
	stack?: Omit<StackOptions, "back">;
	/** Shown until the first page has arrived. */
	loading?: () => TemplateResult;
	/** Shown when the server could not give a page; `retry` asks again. */
	failed?: (error: unknown, retry: () => void) => TemplateResult;
	/** A link off the server (another site, `mailto:`): the platform opens it. */
	open?: (url: string) => void;
}

/** What photon hands back from `resolveComponent`: one of `pages`, a function. */
function isPage(value: unknown): value is PageFunction {
	return typeof value === "function";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);

function serverOrigin(server: string): string {
	const url = new URL(server);
	const local = LOCAL_HOSTS.has(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		throw new OrbitError(
			"E_ORBIT_INSECURE_SERVER",
			`[orbit] serverPages talks to ${url.origin}: use https (plain http only reaches this machine or the emulator's host)`,
		);
	}
	return url.origin;
}

/** The `XSRF-TOKEN` a response set: what photon sends back on a mutation. */
function xsrfFrom(response: Response): string | undefined {
	const header = response.headers.get("set-cookie");
	if (header === null) return undefined;
	const match = /(?:^|[,;]\s*)XSRF-TOKEN=([^;,]*)/.exec(header);
	if (match === null) return undefined;
	try {
		return decodeURIComponent(match[1] ?? "");
	} catch {
		return undefined;
	}
}

const Loading = (): TemplateResult => html`<div class="flex-1"></div>`;

const Failed = (error: unknown, retry: () => void): TemplateResult =>
	html`<div class="flex-1 items-center justify-center gap-4 p-6">
		<p class="text-center">${error instanceof Error ? error.message : String(error)}</p>
		<button class="rounded-md border px-4 py-2" @click=${retry}>Retry</button>
	</div>`;

interface Entry {
	state: unknown;
	url: string;
}

/** The stack the server's pages are shown in; put it in a template. */
export function serverPages(options: ServerPagesOptions): Stack {
	const origin = serverOrigin(options.server);
	const first = new URL(options.url ?? "/", origin).href;
	const failed = options.failed ?? Failed;
	let entries: Entry[] = [{ state: null, url: first }];
	let xsrf: string | undefined;
	let restore: ((state: unknown) => void) | undefined;
	/** The page a visit rendered, waiting for photon to say how it goes in history. */
	let pending: { page: PageFunction; props: Record<string, unknown> } | null =
		null;
	/** The back button asked photon for the previous entry. */
	let popping = false;

	const current = (): Entry => {
		const entry = entries.at(-1);
		if (entry === undefined)
			throw new Error("[orbit] server pages: empty history");
		return entry;
	};
	const absolute = (url: string): string => new URL(url, current().url).href;

	const stack = createStack(options.loading ?? Loading, {
		...options.stack,
		back: () => {
			if (entries.length < 2 || restore === undefined) return false;
			entries.pop();
			popping = true;
			restore(current().state);
			return true;
		},
	});

	/** The visit's page goes in as photon wrote it in history. */
	const place = (how: "push" | "replace"): void => {
		const next = pending;
		pending = null;
		if (next === null) return;
		if (how === "push") stack.push(next.page, next.props);
		else stack.replaceInPlace(next.page, next.props);
	};

	const host: PhotonHost = {
		href: () => current().url,
		baseUri: () => current().url,
		fetch: async (url, init) => {
			const target = absolute(url);
			if (new URL(target).origin !== origin) {
				throw new TypeError(
					`[orbit] server pages only ask ${origin}, not ${target}`,
				);
			}
			// The server is the app's own: its session cookie goes with every
			// request (React Native sends cookies only with credentials).
			const response = await fetch(target, { ...init, credentials: "include" });
			xsrf = xsrfFrom(response) ?? xsrf;
			return response;
		},
		state: () => current().state,
		push: (state, url) => {
			entries.push({ state, url: absolute(url) });
			place("push");
		},
		replace: (state, url) => {
			entries[entries.length - 1] = { state, url: absolute(url) };
			place("replace");
		},
		load: (url) => start(absolute(url)),
		reload: () => start(current().url),
		emit: () => {},
		cookie: (name) => (name === "XSRF-TOKEN" ? xsrf : undefined),
		memoryHistory: true,
		listen: (wire) => {
			restore = wire.restore;
		},
	};

	const adapter: PhotonAdapterHandle = {
		update(page, props) {
			if (!isPage(page)) return;
			if (popping) {
				// The covered screen is the page coming back, as it was left.
				popping = false;
				stack.pop();
				return;
			}
			pending = { page, props };
		},
		unmount() {},
	};

	const resolveComponent = async (
		name: string,
	): Promise<{ default: unknown }> => {
		const page = Object.hasOwn(options.pages, name)
			? options.pages[name]
			: undefined;
		if (page === undefined) {
			throw new OrbitError(
				"E_ORBIT_UNKNOWN_PAGE",
				`[orbit] the server named the page "${name}", which this app does not have`,
			);
		}
		return { default: page };
	};

	/** A first load of `url`: the history starts again from its page. */
	function start(url: string): void {
		entries = [{ state: null, url }];
		pending = null;
		popping = false;
		bootPage({
			host,
			url,
			resolveComponent,
			mount: async (_target, page, data) => {
				if (isPage(page)) stack.reset(page, data.props);
				return adapter;
			},
		}).catch((error: unknown) => {
			stack.reset(() => failed(error, () => start(url)), undefined);
		});
	}

	setLinkHandler((href) => {
		const url = absolute(href);
		if (new URL(url).origin === origin) {
			const target = new URL(url);
			void router.visit(target.pathname + target.search + target.hash);
		} else {
			options.open?.(url);
		}
	});
	start(first);
	return stack;
}
