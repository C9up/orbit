/**
 * The app's ream server, as one connection: what pages, comet calls and relay
 * subscriptions all go through on the phone.
 *
 *     const server = connectServer('https://app.example')
 *     serverPages({ server, pages })
 *     const rpc = createRpcClient({ url: server.url('/rpc'), transport: server.json })
 *     configureRelay({
 *       sseUrl: server.url('/__relay/events'),
 *       subscribeUrl: server.url('/__relay/subscribe'),
 *       unsubscribeUrl: server.url('/__relay/unsubscribe'),
 *       stream: server.stream,
 *       fetch: server.fetch,
 *     })
 *
 * A browser gets this from the page for free: one origin, its cookies sent
 * along, the `XSRF-TOKEN` cookie readable by the page, an `EventSource`. An
 * app has none of it, so the connection gives each: requests to the server's
 * origin only, with the session cookie (React Native sends cookies only with
 * `credentials: 'include'`), the `XSRF-TOKEN` the server set echoed on every
 * mutation, and server-sent events read from React Native's streaming XHR.
 */

import { OrbitError } from "./errors.js";

export interface ServerConnection {
	/** The server's origin (`https://app.example`). */
	readonly origin: string;
	/** `path` on the server, absolute. */
	url(path: string): string;
	/**
	 * A request to the server: refused for another origin, carrying the
	 * session cookie and, on a mutation, the `X-XSRF-TOKEN` the server's
	 * `XSRF-TOKEN` cookie set.
	 */
	fetch(url: string, init?: RequestInit): Promise<Response>;
	/**
	 * POST `body` as JSON and resolve the JSON answer (nothing for a 204): the
	 * shape of comet's `RpcTransport`.
	 */
	json(
		url: string,
		body: unknown,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
	/** A server-sent event stream at `url`: what relay's `stream` option takes. */
	stream(url: string): ServerEventStream;
	/** The `XSRF-TOKEN` the server set last, if any. */
	xsrf(): string | undefined;
	/**
	 * Send `Authorization: Bearer <token>` with every request and stream from
	 * now on (`null` stops): an API's token, which — unlike a browser's
	 * `EventSource` — the phone can send on server-sent events too. With a
	 * `tokenStore`, the token is kept there too (and forgotten on `null`);
	 * the promise settles once it is.
	 */
	authorize(token: string | null): Promise<void>;
	/**
	 * Authorize again with the token the `tokenStore` kept, as when the app
	 * starts: true when there was one. Without a store, false.
	 */
	restore(): Promise<boolean>;
}

/**
 * Where a connection keeps its API token between launches — on a phone,
 * `@c9up/orbit-secure-store`'s getItem / setItem / deleteItem under a key:
 *
 *     connectServer(origin, { tokenStore: {
 *       get: () => getItem('session'),
 *       set: (token) => token === null ? deleteItem('session') : setItem('session', token),
 *     } })
 */
export interface TokenStore {
	get(): Promise<string | null>;
	set(token: string | null): Promise<void>;
}

export interface ConnectOptions {
	/** Keeps the token `authorize` sets, so `restore` finds it at the next launch. */
	tokenStore?: TokenStore;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The `XSRF-TOKEN` a response set, verbatim (the server compares bytes). */
function xsrfFrom(response: Response): string | undefined {
	const header = response.headers.get("set-cookie");
	if (header === null) return undefined;
	const match = /(?:^|[,;]\s*)XSRF-TOKEN=([^;,]*)/.exec(header);
	return match === null ? undefined : match[1];
}

/** Connect to the app's ream server: https, or http to this machine or the emulator's host. */
export function connectServer(
	server: string,
	options: ConnectOptions = {},
): ServerConnection {
	const base = new URL(server);
	const local = LOCAL_HOSTS.has(base.hostname);
	if (base.protocol !== "https:" && !(base.protocol === "http:" && local)) {
		throw new OrbitError(
			"E_ORBIT_INSECURE_SERVER",
			`[orbit] the server ${base.origin} is not https (plain http only reaches this machine or the emulator's host)`,
		);
	}
	const origin = base.origin;
	let token: string | undefined;
	let bearer: string | null = null;

	const url = (path: string): string => {
		const target = new URL(path, `${origin}/`).href;
		if (new URL(target).origin !== origin) {
			throw new TypeError(
				`[orbit] the connection to ${origin} does not reach ${target}`,
			);
		}
		return target;
	};

	const request = async (
		target: string,
		init: RequestInit = {},
	): Promise<Response> => {
		const absolute = url(target);
		const method = (init.method ?? "GET").toUpperCase();
		const headers = new Headers(init.headers);
		if (
			!SAFE_METHODS.has(method) &&
			token !== undefined &&
			!headers.has("x-xsrf-token")
		) {
			headers.set("x-xsrf-token", token);
		}
		if (bearer !== null && !headers.has("authorization")) {
			headers.set("authorization", `Bearer ${bearer}`);
		}
		const response = await fetch(absolute, {
			...init,
			headers,
			credentials: "include",
		});
		token = xsrfFrom(response) ?? token;
		return response;
	};

	return {
		origin,
		url,
		fetch: request,
		json: async (target, body, options = {}) => {
			const response = await request(target, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify(body),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			const text = await response.text();
			if (text !== "") return JSON.parse(text);
			if (response.ok) return undefined;
			throw new Error(`[orbit] ${target} answered HTTP ${response.status}`);
		},
		stream: (target) =>
			new ServerEventStream(url(target), () => ({
				...(token === undefined ? {} : { "x-xsrf-token": token }),
				...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
			})),
		xsrf: () => token,
		authorize: async (next) => {
			bearer = next;
			await options.tokenStore?.set(next);
		},
		restore: async () => {
			const kept = await options.tokenStore?.get();
			if (typeof kept !== "string" || kept === "") return false;
			bearer = kept;
			return true;
		},
	};
}

/** A server-sent event: its type, data and id, as an `EventSource`'s `MessageEvent` carries them. */
export interface ServerEvent {
	readonly type: string;
	readonly data?: string;
	readonly lastEventId?: string;
}

type Listener = (event: ServerEvent) => void;

/** The part of React Native's (and the browser's) XMLHttpRequest a stream reads. */
interface StreamingRequest {
	readyState: number;
	status: number;
	responseText: string;
	withCredentials: boolean;
	onprogress: (() => void) | null;
	onreadystatechange: (() => void) | null;
	onerror: (() => void) | null;
	onload: (() => void) | null;
	open(method: string, url: string): void;
	setRequestHeader(name: string, value: string): void;
	getResponseHeader(name: string): string | null;
	send(): void;
	abort(): void;
}

function isStreamingRequest(value: unknown): value is StreamingRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "open") === "function" &&
		typeof Reflect.get(value, "send") === "function"
	);
}

function createRequest(): StreamingRequest {
	const Xhr: unknown = Reflect.get(globalThis, "XMLHttpRequest");
	const request: unknown =
		typeof Xhr === "function" ? Reflect.construct(Xhr, []) : undefined;
	if (!isStreamingRequest(request)) {
		throw new TypeError("[orbit] server events need XMLHttpRequest");
	}
	return request;
}

/** The time before reconnecting when the server set none (`retry:`), in ms. */
const DEFAULT_RETRY = 3000;

/**
 * Server-sent events over XHR — what `EventSource` does, where there is
 * none (React Native): the stream is read as it arrives, parsed as the
 * HTML standard says (`event:`, `data:`, `id:`, `retry:`, comments), each
 * event dispatched under its type; a dropped connection dispatches `error`
 * and reconnects after `retry` ms with `Last-Event-ID`. An answer that is
 * not a 200 `text/event-stream` fails the stream for good (`error`, no
 * reconnect), as `EventSource` does.
 */
export class ServerEventStream {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;

	readonly url: string;
	readyState = ServerEventStream.CONNECTING;
	readonly #listeners = new Map<string, Set<Listener>>();
	readonly #headers: () => Record<string, string>;
	readonly #credentials: boolean;
	#request: StreamingRequest | null = null;
	#retry = DEFAULT_RETRY;
	#lastEventId = "";
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		url: string,
		headers: () => Record<string, string> = () => ({}),
		options: { credentials?: boolean } = {},
	) {
		this.url = url;
		this.#headers = headers;
		this.#credentials = options.credentials ?? true;
		this.#connect();
	}

	addEventListener(type: string, listener: Listener): void {
		const set = this.#listeners.get(type) ?? new Set();
		set.add(listener);
		this.#listeners.set(type, set);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.readyState = ServerEventStream.CLOSED;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		const request = this.#request;
		this.#request = null;
		request?.abort();
	}

	#dispatch(event: ServerEvent): void {
		for (const listener of [...(this.#listeners.get(event.type) ?? [])]) {
			listener(event);
		}
	}

	#connect(): void {
		const request = createRequest();
		this.#request = request;
		let read = 0;
		let buffer = "";
		let type = "";
		let data: string[] = [];
		let checked = false;

		const line = (text: string): void => {
			if (text === "") {
				if (data.length > 0) {
					this.#dispatch({
						type: type === "" ? "message" : type,
						data: data.join("\n"),
						lastEventId: this.#lastEventId,
					});
				}
				type = "";
				data = [];
				return;
			}
			if (text.startsWith(":")) return;
			const colon = text.indexOf(":");
			const field = colon < 0 ? text : text.slice(0, colon);
			let value = colon < 0 ? "" : text.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "event") type = value;
			else if (field === "data") data.push(value);
			else if (field === "id" && !value.includes("\0"))
				this.#lastEventId = value;
			else if (field === "retry" && /^\d+$/.test(value))
				this.#retry = Number(value);
		};

		const fail = (): boolean => {
			if (checked) return false;
			// Status 0 is a network failure, not an answer: `ended` reconnects.
			if (request.readyState < 2 || request.status === 0) return false;
			checked = true;
			const contentType = request.getResponseHeader("content-type") ?? "";
			if (request.status === 200 && contentType.includes("text/event-stream")) {
				this.readyState = ServerEventStream.OPEN;
				this.#dispatch({ type: "open" });
				return false;
			}
			// Not a stream: fail it for good, as EventSource does.
			this.#request = null;
			request.abort();
			this.readyState = ServerEventStream.CLOSED;
			this.#dispatch({ type: "error" });
			return true;
		};

		const progress = (): void => {
			if (this.#request !== request || fail()) return;
			const text = request.responseText;
			if (text.length <= read) return;
			let pending = buffer + text.slice(read);
			read = text.length;
			// A trailing `\r` may be the first half of a `\r\n` split across
			// chunks: hold it back, or the `\n` would end a second, empty line.
			const held = pending.endsWith("\r") ? "\r" : "";
			if (held !== "") pending = pending.slice(0, -1);
			const parts = pending.split(/\r\n|\r|\n/);
			buffer = (parts.pop() ?? "") + held;
			for (const part of parts) line(part);
		};

		const ended = (): void => {
			if (this.#request !== request) return;
			progress();
			if (this.readyState === ServerEventStream.CLOSED) return;
			this.#request = null;
			this.readyState = ServerEventStream.CONNECTING;
			this.#dispatch({ type: "error" });
			if (this.readyState !== ServerEventStream.CONNECTING) return;
			this.#timer = setTimeout(() => {
				this.#timer = null;
				if (this.readyState === ServerEventStream.CONNECTING) this.#connect();
			}, this.#retry);
		};

		request.onreadystatechange = () => {
			if (request.readyState >= 2) progress();
		};
		request.onprogress = progress;
		request.onload = ended;
		request.onerror = ended;
		request.open("GET", this.url);
		request.withCredentials = this.#credentials;
		request.setRequestHeader("accept", "text/event-stream");
		request.setRequestHeader("cache-control", "no-cache");
		if (this.#lastEventId !== "") {
			request.setRequestHeader("last-event-id", this.#lastEventId);
		}
		for (const [name, value] of Object.entries(this.#headers())) {
			request.setRequestHeader(name, value);
		}
		request.send();
	}
}
