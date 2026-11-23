import { afterEach, describe, expect, it } from "vitest";
import { installStandardUrl, StandardURL } from "../../src/url.js";

const PARTS = [
	"href",
	"protocol",
	"host",
	"hostname",
	"port",
	"origin",
	"pathname",
	"search",
	"hash",
] as const;

function parts(url: URL | StandardURL) {
	return Object.fromEntries(PARTS.map((name) => [name, url[name]]));
}

describe("StandardURL", () => {
	const base = "https://App.Example:443/a/b/c?q=1#top";
	const references = [
		"/orders",
		"/orders?page=2#list",
		"order/7",
		"./x",
		"../x",
		"../../../../x",
		"?page=3",
		"#section",
		"",
		"//cdn.example/lib.js",
		"https://other.example:8443/p/../q?z",
		"http://h.test",
		"/a/./b/../c/",
		"/a/b/..",
		"x/.",
	];
	for (const reference of references) {
		it(`resolves ${JSON.stringify(reference)} as the standard does`, () => {
			expect(parts(new StandardURL(reference, base))).toEqual(
				parts(new URL(reference, base)),
			);
		});
	}

	it("parses an absolute URL with credentials and a port as the standard does", () => {
		const input = "HTTP://user:pw@Host.Test:8080/p?x=1#h";
		expect(parts(new StandardURL(input))).toEqual(parts(new URL(input)));
		expect(new StandardURL(input).username).toBe("user");
	});

	it("keeps an opaque URL as written", () => {
		expect(new StandardURL("mailto:a@b.test").href).toBe("mailto:a@b.test");
		expect(new StandardURL("mailto:a@b.test").origin).toBe("null");
	});

	it("writes searchParams changes into search, as photon's withQuery needs", () => {
		const url = new StandardURL("/list?a=1&b=2", "https://h.test/");
		url.searchParams.delete("a");
		url.searchParams.append("c", "x y");
		expect(url.search).toBe("?b=2&c=x+y");
		expect(url.pathname + url.search).toBe("/list?b=2&c=x+y");
		url.search = "";
		expect(url.searchParams.get("b")).toBeNull();
	});

	it("refuses a relative URL with no base, and a base that is not a URL", () => {
		expect(() => new StandardURL("/orders")).toThrow(TypeError);
		expect(() => new StandardURL("/orders", "nowhere")).toThrow(TypeError);
		expect(() => new StandardURL("/orders")).toThrow(
			expect.objectContaining({
				name: "TypeError",
				code: "E_ORBIT_INVALID_URL",
			}),
		);
		expect(() => new StandardURL("/orders", "nowhere")).toThrow(
			expect.objectContaining({ code: "E_ORBIT_INVALID_URL" }),
		);
		expect(StandardURL.canParse("/x", "https://h.test")).toBe(true);
	});
});

describe("installStandardUrl", () => {
	const original = globalThis.URL;
	afterEach(() => {
		globalThis.URL = original;
	});

	it("leaves a standard URL alone", () => {
		expect(installStandardUrl()).toBe(false);
		expect(globalThis.URL).toBe(original);
	});

	it("replaces a URL that appends a reference to its base, as React Native's does", () => {
		class AppendingURL extends URL {
			constructor(url: string | URL, base?: string | URL) {
				super(
					base === undefined
						? url
						: `${String(base).replace(/\/$/, "")}/${String(url).replace(/^\//, "")}`,
				);
			}
		}
		globalThis.URL = AppendingURL;
		expect(installStandardUrl()).toBe(true);
		expect(new URL("/b", "https://h.test/a").href).toBe("https://h.test/b");
	});
});
