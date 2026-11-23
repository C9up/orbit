/**
 * A standard `URL` for the phone, installed when the platform's is not one.
 *
 * React Native's `URL` (0.87) parses with regular expressions: a relative
 * reference is appended to the base (`new URL("/b", "https://h/a")` gives
 * `https://h/a/b`), and `searchParams` is a copy that `search` never sees.
 * photon's router — and any code an app shares with the browser — resolves
 * links and builds queries through it. `installStandardUrl()` probes the
 * global `URL` and, when it gets either wrong, puts this one in its place.
 *
 * Scope: hierarchical URLs (`http:`, `https:`, `ws:`, `wss:`, `file:`…)
 * resolved as RFC 3986 says, parts read and written as WHATWG's `URL` does;
 * an opaque one (`mailto:`, `tel:`, `blob:`) is kept as written.
 */

import {
	E_ORBIT_INVALID_URL,
	E_ORBIT_OBJECT_URL_UNAVAILABLE,
} from "./errors.js";

const SCHEME = /^([a-zA-Z][a-zA-Z\d+.-]*):/;
const DEFAULT_PORTS: { [scheme: string]: string } = {
	"http:": "80",
	"https:": "443",
	"ws:": "80",
	"wss:": "443",
	"ftp:": "21",
};
const SPECIAL = new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);

interface Parts {
	protocol: string;
	username: string;
	password: string;
	hostname: string;
	port: string;
	pathname: string;
	search: string;
	hash: string;
	/** An opaque URL (`mailto:x`): what follows the scheme, as written. */
	opaque: string | null;
}

/** RFC 3986 §5.2.4. */
function removeDotSegments(path: string): string {
	const out: string[] = [];
	const segments = path.split("/");
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i] ?? "";
		const last = i === segments.length - 1;
		if (segment === ".") {
			if (last) out.push("");
		} else if (segment === "..") {
			if (out.length > 1) out.pop();
			if (last) out.push("");
		} else {
			out.push(segment);
		}
	}
	const joined = out.join("/");
	return joined.startsWith("/") ? joined : `/${joined}`;
}

function splitTail(rest: string): {
	path: string;
	search: string;
	hash: string;
} {
	const hashAt = rest.indexOf("#");
	const hash = hashAt >= 0 ? rest.slice(hashAt) : "";
	const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
	const queryAt = beforeHash.indexOf("?");
	const search = queryAt >= 0 ? beforeHash.slice(queryAt) : "";
	const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
	return {
		path,
		search: search === "?" ? "" : search,
		hash: hash === "#" ? "" : hash,
	};
}

function parseAbsolute(input: string): Parts | null {
	const scheme = SCHEME.exec(input);
	if (scheme === null) return null;
	const protocol = `${(scheme[1] ?? "").toLowerCase()}:`;
	let rest = input.slice(scheme[0].length).replace(/\\/g, "/");
	if (!SPECIAL.has(protocol) && !rest.startsWith("//")) {
		return {
			protocol,
			username: "",
			password: "",
			hostname: "",
			port: "",
			pathname: rest,
			search: "",
			hash: "",
			opaque: rest,
		};
	}
	rest = rest.replace(/^\/*/, "");
	const end = rest.search(/[/?#]/);
	const authority = end >= 0 ? rest.slice(0, end) : rest;
	const tail = splitTail(end >= 0 ? rest.slice(end) : "");
	const at = authority.lastIndexOf("@");
	const userInfo = at >= 0 ? authority.slice(0, at) : "";
	const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
	const colon = userInfo.indexOf(":");
	const portMatch = /:(\d*)$/.exec(hostPort);
	const hostname = (
		portMatch ? hostPort.slice(0, portMatch.index) : hostPort
	).toLowerCase();
	if (hostname === "" && protocol !== "file:") return null;
	const port = portMatch?.[1] ?? "";
	return {
		protocol,
		username: colon >= 0 ? userInfo.slice(0, colon) : userInfo,
		password: colon >= 0 ? userInfo.slice(colon + 1) : "",
		hostname,
		port: port === DEFAULT_PORTS[protocol] ? "" : port.replace(/^0+(?=\d)/, ""),
		pathname: removeDotSegments(tail.path === "" ? "/" : tail.path),
		search: tail.search,
		hash: tail.hash,
		opaque: null,
	};
}

/** RFC 3986 §5.2.2: `reference` against an absolute `base`. */
function resolve(reference: string, base: Parts): Parts | null {
	const ref = reference.trim();
	if (SCHEME.test(ref)) return parseAbsolute(ref);
	if (base.opaque !== null) return null;
	if (ref.startsWith("//") || ref.startsWith("\\\\")) {
		return parseAbsolute(`${base.protocol}${ref}`);
	}
	const tail = splitTail(ref.replace(/\\/g, "/"));
	const next: Parts = { ...base, hash: tail.hash };
	if (tail.path === "") {
		if (tail.search !== "" || ref.includes("?")) next.search = tail.search;
		return next;
	}
	next.search = tail.search;
	if (tail.path.startsWith("/")) {
		next.pathname = removeDotSegments(tail.path);
	} else {
		const dir = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
		next.pathname = removeDotSegments(`${dir}${tail.path}`);
	}
	return next;
}

/** A query whose changes reach the URL it belongs to, as WHATWG's does. */
class LinkedSearchParams extends URLSearchParams {
	readonly #changed: (query: string) => void;
	constructor(query: string, changed: (query: string) => void) {
		super(query);
		this.#changed = changed;
	}
	override append(name: string, value: string): void {
		super.append(name, value);
		this.#changed(this.toString());
	}
	override delete(name: string): void {
		super.delete(name);
		this.#changed(this.toString());
	}
	override set(name: string, value: string): void {
		super.set(name, value);
		this.#changed(this.toString());
	}
	override sort(): void {
		super.sort();
		this.#changed(this.toString());
	}
}

/** The platform's own `URL`, kept for its `createObjectURL` (blobs). */
type PlatformUrl = typeof URL;

let platformUrl: PlatformUrl | undefined;

export class StandardURL {
	#parts: Parts;
	#query: LinkedSearchParams | null = null;

	static createObjectURL(blob: Blob): string {
		if (platformUrl === undefined)
			throw new E_ORBIT_OBJECT_URL_UNAVAILABLE(
				"URL.createObjectURL is not available",
			);
		return platformUrl.createObjectURL(blob);
	}

	static revokeObjectURL(url: string): void {
		platformUrl?.revokeObjectURL(url);
	}

	static canParse(url: string, base?: string | StandardURL): boolean {
		try {
			new StandardURL(url, base);
			return true;
		} catch {
			return false;
		}
	}

	constructor(url: string | StandardURL, base?: string | StandardURL) {
		const input = String(url);
		let parts: Parts | null;
		if (base === undefined) {
			parts = parseAbsolute(input.trim());
		} else {
			const from =
				base instanceof StandardURL
					? base.#parts
					: parseAbsolute(String(base).trim());
			if (from === null)
				throw new E_ORBIT_INVALID_URL(`Invalid base URL: ${String(base)}`);
			parts = resolve(input, from);
		}
		if (parts === null) throw new E_ORBIT_INVALID_URL(`Invalid URL: ${input}`);
		this.#parts = parts;
	}

	get protocol(): string {
		return this.#parts.protocol;
	}
	get username(): string {
		return this.#parts.username;
	}
	get password(): string {
		return this.#parts.password;
	}
	get hostname(): string {
		return this.#parts.hostname;
	}
	get port(): string {
		return this.#parts.port;
	}
	get host(): string {
		const { hostname, port } = this.#parts;
		return port === "" ? hostname : `${hostname}:${port}`;
	}
	get origin(): string {
		const { protocol, opaque } = this.#parts;
		if (opaque !== null || protocol === "file:") return "null";
		return `${protocol}//${this.host}`;
	}
	get pathname(): string {
		return this.#parts.pathname;
	}
	set pathname(value: string) {
		if (this.#parts.opaque !== null) return;
		this.#parts.pathname = removeDotSegments(
			value.startsWith("/") ? value : `/${value}`,
		);
	}
	get search(): string {
		return this.#parts.search;
	}
	set search(value: string) {
		const query = value.startsWith("?") ? value.slice(1) : value;
		this.#parts.search = query === "" ? "" : `?${query}`;
		this.#query = null;
	}
	get hash(): string {
		return this.#parts.hash;
	}
	set hash(value: string) {
		const fragment = value.startsWith("#") ? value.slice(1) : value;
		this.#parts.hash = fragment === "" ? "" : `#${fragment}`;
	}
	get searchParams(): URLSearchParams {
		if (this.#query === null) {
			this.#query = new LinkedSearchParams(this.#parts.search, (query) => {
				this.#parts.search = query === "" ? "" : `?${query}`;
			});
		}
		return this.#query;
	}
	get href(): string {
		const { protocol, username, password, opaque, pathname, search, hash } =
			this.#parts;
		if (opaque !== null) return `${protocol}${opaque}`;
		const credentials =
			username === "" && password === ""
				? ""
				: `${username}${password === "" ? "" : `:${password}`}@`;
		return `${protocol}//${credentials}${this.host}${pathname}${search}${hash}`;
	}
	toString(): string {
		return this.href;
	}
	toJSON(): string {
		return this.href;
	}
}

/** Whether `Url` resolves references and links its query as the standard says. */
function isStandard(Url: PlatformUrl): boolean {
	try {
		if (
			new Url("/b?x=1", "https://h.test/a/c").href !== "https://h.test/b?x=1"
		) {
			return false;
		}
		if (new Url("../d", "https://h.test/a/b/c").href !== "https://h.test/a/d") {
			return false;
		}
		const url = new Url("https://h.test/");
		url.searchParams.append("q", "1");
		return url.search === "?q=1";
	} catch {
		return false;
	}
}

/**
 * Put a standard `URL` in place of the platform's when the platform's is not
 * one; true when it did. The platform's `createObjectURL` (blobs) stays
 * reachable through the new one.
 */
export function installStandardUrl(): boolean {
	const current: unknown = Reflect.get(globalThis, "URL");
	if (typeof current !== "function") {
		Reflect.set(globalThis, "URL", StandardURL);
		return true;
	}
	const platform: PlatformUrl = Reflect.get(globalThis, "URL");
	if (isStandard(platform)) return false;
	platformUrl = platform;
	Reflect.set(globalThis, "URL", StandardURL);
	return true;
}
