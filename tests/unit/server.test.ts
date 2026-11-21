import { afterEach, describe, expect, it, vi } from "vitest";
import { connectServer, ServerEventStream } from "../../src/server.js";

const SERVER = "https://app.example";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** React Native's XMLHttpRequest as a stream reads it: the text grows as it arrives. */
class FakeXhr {
	static all: FakeXhr[] = [];
	readyState = 0;
	status = 0;
	responseText = "";
	withCredentials = false;
	onprogress: (() => void) | null = null;
	onreadystatechange: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onload: (() => void) | null = null;
	url = "";
	aborted = false;
	readonly headers: Record<string, string> = {};
	#contentType = "text/event-stream";

	constructor() {
		FakeXhr.all.push(this);
	}
	open(_method: string, url: string): void {
		this.url = url;
		this.readyState = 1;
	}
	setRequestHeader(name: string, value: string): void {
		this.headers[name] = value;
	}
	getResponseHeader(name: string): string | null {
		return name === "content-type" ? this.#contentType : null;
	}
	send(): void {}
	abort(): void {
		this.aborted = true;
	}
	/** The server answers with headers. */
	answer(status = 200, contentType = "text/event-stream"): void {
		this.status = status;
		this.#contentType = contentType;
		this.readyState = 2;
		this.onreadystatechange?.();
	}
	/** More of the body arrives. */
	chunk(text: string): void {
		this.readyState = 3;
		this.responseText += text;
		this.onprogress?.();
	}
	/** The connection ends. */
	end(): void {
		this.readyState = 4;
		this.onload?.();
	}
}

function latest(): FakeXhr {
	const xhr = FakeXhr.all.at(-1);
	if (xhr === undefined) throw new Error("no request");
	return xhr;
}

function record(stream: ServerEventStream, ...types: string[]) {
	const seen: Array<[string, string | undefined]> = [];
	for (const type of types) {
		stream.addEventListener(type, (event) =>
			seen.push([event.type, event.data]),
		);
	}
	return seen;
}

describe("connectServer", () => {
	it("keeps to the server's origin, sends the cookie, and echoes the XSRF token on mutations only", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "set-cookie": "XSRF-TOKEN=ab.cd; Path=/" },
				});
			}),
		);
		const server = connectServer(SERVER);
		expect(server.url("/rpc")).toBe(`${SERVER}/rpc`);
		expect(() => server.url("https://evil.example/x")).toThrow(TypeError);
		await expect(server.fetch("//evil.example/x")).rejects.toThrow(TypeError);

		await server.fetch("/");
		expect(server.xsrf()).toBe("ab.cd");
		expect(calls[0]?.init.credentials).toBe("include");
		expect(new Headers(calls[0]?.init.headers).has("x-xsrf-token")).toBe(false);

		await expect(server.json("/rpc", { jsonrpc: "2.0" })).resolves.toEqual({
			ok: true,
		});
		const post = calls[1];
		expect(post?.url).toBe(`${SERVER}/rpc`);
		expect(new Headers(post?.init.headers).get("x-xsrf-token")).toBe("ab.cd");
		expect(post?.init.body).toBe('{"jsonrpc":"2.0"}');

		// An API token goes with every request, and with the event stream.
		server.authorize("jwt-1");
		await server.fetch("/me");
		expect(new Headers(calls[2]?.init.headers).get("authorization")).toBe(
			"Bearer jwt-1",
		);
		FakeXhr.all = [];
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		server.stream("/__relay/events");
		expect(latest().headers).toMatchObject({
			authorization: "Bearer jwt-1",
			"x-xsrf-token": "ab.cd",
		});
		server.authorize(null);
		await server.fetch("/me");
		expect(new Headers(calls[3]?.init.headers).has("authorization")).toBe(
			false,
		);
	});

	it("answers nothing for a 204, and throws on an empty failure", async () => {
		let status = 204;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status })),
		);
		const server = connectServer(SERVER);
		await expect(server.json("/rpc", {})).resolves.toBeUndefined();
		status = 500;
		await expect(server.json("/rpc", {})).rejects.toThrow(/HTTP 500/);
	});

	it("refuses plain http to anything but this machine or the emulator's host", () => {
		expect(() => connectServer("http://app.example")).toThrow(
			expect.objectContaining({ code: "E_ORBIT_INSECURE_SERVER" }),
		);
		expect(connectServer("http://localhost:3333").origin).toBe(
			"http://localhost:3333",
		);
	});
});

describe("ServerEventStream", () => {
	it("parses events as EventSource does, across chunks", () => {
		FakeXhr.all = [];
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const stream = new ServerEventStream(`${SERVER}/__relay/events`, () => ({
			"x-xsrf-token": "tok",
		}));
		const seen = record(stream, "open", "message", "connected", "orders");
		const xhr = latest();
		expect(xhr.withCredentials).toBe(true);
		expect(xhr.headers).toMatchObject({
			accept: "text/event-stream",
			"x-xsrf-token": "tok",
		});

		xhr.answer();
		expect(stream.readyState).toBe(ServerEventStream.OPEN);
		xhr.chunk(': keep-alive\n\nevent: connected\ndata: {"uid":');
		xhr.chunk('"u1"}\n\nevent: orders\r');
		xhr.chunk("\ndata: line one\ndata: line two\r\n\r\ndata: plain\n\n");
		expect(seen).toEqual([
			["open", undefined],
			["connected", '{"uid":"u1"}'],
			["orders", "line one\nline two"],
			["message", "plain"],
		]);
	});

	it("reconnects after a dropped connection, with Last-Event-ID and the server's retry", () => {
		vi.useFakeTimers();
		FakeXhr.all = [];
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const stream = new ServerEventStream(`${SERVER}/events`);
		const seen = record(stream, "error", "message");
		latest().answer();
		latest().chunk("retry: 500\nid: 42\ndata: a\n\n");
		latest().end();
		expect(seen).toEqual([
			["message", "a"],
			["error", undefined],
		]);
		expect(stream.readyState).toBe(ServerEventStream.CONNECTING);
		vi.advanceTimersByTime(499);
		expect(FakeXhr.all).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeXhr.all).toHaveLength(2);
		expect(latest().headers["last-event-id"]).toBe("42");

		// Closed: no reconnect any more.
		stream.close();
		expect(latest().aborted).toBe(true);
		vi.advanceTimersByTime(10_000);
		expect(FakeXhr.all).toHaveLength(2);
	});

	it("fails for good on an answer that is not an event stream", () => {
		vi.useFakeTimers();
		FakeXhr.all = [];
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		const stream = new ServerEventStream(`${SERVER}/events`);
		const seen = record(stream, "error");
		latest().answer(403, "application/json");
		expect(seen).toEqual([["error", undefined]]);
		expect(stream.readyState).toBe(ServerEventStream.CLOSED);
		vi.advanceTimersByTime(10_000);
		expect(FakeXhr.all).toHaveLength(1);
	});
});
