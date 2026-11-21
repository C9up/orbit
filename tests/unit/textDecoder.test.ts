/**
 * orbit's UTF-8 TextDecoder against Node's (the WHATWG reference) on valid,
 * malformed and random input, whole and streamed.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	installTextDecoder,
	StandardTextDecoder,
} from "../../src/textDecoder.js";

const node = (bytes: Uint8Array, fatal = false) => {
	try {
		return new TextDecoder("utf-8", { fatal }).decode(bytes);
	} catch (error) {
		return `throws ${error instanceof TypeError}`;
	}
};
const ours = (bytes: Uint8Array, fatal = false) => {
	try {
		return new StandardTextDecoder("utf-8", { fatal }).decode(bytes);
	} catch (error) {
		return `throws ${error instanceof TypeError}`;
	}
};

/** A deterministic generator (no Math.random: the test is the same every run). */
function* pseudoRandom(seed: number) {
	let x = seed;
	while (true) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		yield x;
	}
}

describe("StandardTextDecoder", () => {
	it("decodes what TextEncoder encodes, astral planes included", () => {
		const text = "safety 42 — é ✓ 𝄞 😀 日本語";
		expect(
			new StandardTextDecoder().decode(new TextEncoder().encode(text)),
		).toBe(text);
	});

	it("replaces malformed sequences exactly as the standard does, or throws with fatal", () => {
		const cases = [
			[0xff],
			[0xc0, 0x80],
			[0xe0, 0x80, 0x80],
			[0xed, 0xa0, 0x80],
			[0xf4, 0x90, 0x80, 0x80],
			[0xf0, 0x9f, 0x98],
			[0xe2, 0x82, 0x41],
			[0x61, 0xc3],
			[0xf0, 0x9f, 0x41, 0x80],
		];
		for (const raw of cases) {
			const bytes = new Uint8Array(raw);
			expect(ours(bytes), raw.join(",")).toBe(node(bytes));
			expect(ours(bytes, true), raw.join(",")).toBe(node(bytes, true));
		}
	});

	it("matches Node on random bytes, whole and streamed at every split", () => {
		const next = pseudoRandom(7);
		for (let round = 0; round < 300; round++) {
			const length = (next.next().value ?? 0) % 24;
			const bytes = new Uint8Array(length);
			for (let i = 0; i < length; i++) {
				const v = next.next().value ?? 0;
				// Mostly multi-byte territory, where the errors are.
				bytes[i] = v % 3 === 0 ? v % 0x80 : 0x80 + (v % 0x80);
			}
			const expected = node(bytes);
			expect(ours(bytes)).toBe(expected);
			for (let split = 0; split <= length; split++) {
				const decoder = new StandardTextDecoder();
				const streamed =
					decoder.decode(bytes.subarray(0, split), { stream: true }) +
					decoder.decode(bytes.subarray(split));
				expect(streamed, `${Array.from(bytes)} @${split}`).toBe(expected);
			}
		}
	});

	it("drops a leading BOM unless told not to, and refuses another encoding", () => {
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		expect(new StandardTextDecoder().decode(bom)).toBe("a");
		expect(
			new StandardTextDecoder("utf8", { ignoreBOM: true }).decode(bom),
		).toBe("﻿a");
		expect(() => new StandardTextDecoder("latin1")).toThrow(RangeError);
		expect(new StandardTextDecoder().decode()).toBe("");
		expect(
			new StandardTextDecoder().decode(new Uint16Array([0x6261]).buffer),
		).toBe(new TextDecoder().decode(new Uint16Array([0x6261]).buffer));
	});
});

describe("installTextDecoder", () => {
	const original = globalThis.TextDecoder;
	afterEach(() => {
		globalThis.TextDecoder = original;
	});

	it("leaves the engine's own alone, and installs one where there is none (Hermes)", () => {
		expect(installTextDecoder()).toBe(false);
		Reflect.deleteProperty(globalThis, "TextDecoder");
		expect(installTextDecoder()).toBe(true);
		expect(new TextDecoder().decode(new Uint8Array([0xc3, 0xa9]))).toBe("é");
	});
});
