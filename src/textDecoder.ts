/**
 * A standard UTF-8 `TextDecoder` for the phone, installed when the engine has
 * none: Hermes has `TextEncoder` but not `TextDecoder`, so a library shared
 * with the web (msgpack, protobuf, any binary protocol) dies at load with
 * "Property 'TextDecoder' doesn't exist".
 *
 * The WHATWG Encoding standard's UTF-8 decoder: invalid sequences become
 * U+FFFD by its maximal-subpart rule (or throw a TypeError with `fatal`), a
 * leading BOM is dropped unless `ignoreBOM`, and `{ stream: true }` keeps an
 * incomplete sequence for the next call. UTF-8 only: another label throws a
 * RangeError, as the standard does for a label it does not know.
 */

const LABELS = new Set([
	"utf-8",
	"utf8",
	"unicode-1-1-utf-8",
	"unicode11utf8",
	"unicode20utf8",
	"x-unicode20utf8",
]);

/** How many code points become one string at a time (fromCodePoint's argument list). */
const CHUNK = 8192;

export interface StandardTextDecoderOptions {
	fatal?: boolean;
	ignoreBOM?: boolean;
}

function bytesOf(input: ArrayBuffer | ArrayBufferView | undefined): Uint8Array {
	if (input === undefined) return new Uint8Array(0);
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	if (ArrayBuffer.isView(input)) {
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	}
	throw new TypeError(
		"The provided value is not of type '(ArrayBuffer or ArrayBufferView)'",
	);
}

export class StandardTextDecoder {
	readonly encoding = "utf-8";
	readonly fatal: boolean;
	readonly ignoreBOM: boolean;
	#needed = 0;
	#seen = 0;
	#codePoint = 0;
	#lower = 0x80;
	#upper = 0xbf;
	/** Whether the next code point is the first of the stream (a BOM there is dropped). */
	#start = true;

	constructor(label = "utf-8", options: StandardTextDecoderOptions = {}) {
		if (!LABELS.has(String(label).trim().toLowerCase())) {
			throw new RangeError(
				`The encoding label provided ('${label}') is invalid.`,
			);
		}
		this.fatal = options.fatal === true;
		this.ignoreBOM = options.ignoreBOM === true;
	}

	decode(
		input?: ArrayBuffer | ArrayBufferView,
		options: { stream?: boolean } = {},
	): string {
		const bytes = bytesOf(input);
		const stream = options.stream === true;
		const out: string[] = [];
		const points: number[] = [];
		const emit = (point: number): void => {
			if (this.#start) {
				this.#start = false;
				if (point === 0xfeff && !this.ignoreBOM) return;
			}
			points.push(point);
			if (points.length === CHUNK) {
				out.push(String.fromCodePoint(...points));
				points.length = 0;
			}
		};
		const error = (): void => {
			if (this.fatal) {
				this.#reset();
				this.#start = true;
				throw new TypeError(
					"The encoded data was not valid for encoding utf-8",
				);
			}
			emit(0xfffd);
		};
		for (let i = 0; i < bytes.length; i++) {
			const byte = bytes[i] ?? 0;
			if (this.#needed === 0) {
				if (byte <= 0x7f) emit(byte);
				else if (byte >= 0xc2 && byte <= 0xdf) {
					this.#needed = 1;
					this.#codePoint = byte & 0x1f;
				} else if (byte >= 0xe0 && byte <= 0xef) {
					if (byte === 0xe0) this.#lower = 0xa0;
					if (byte === 0xed) this.#upper = 0x9f;
					this.#needed = 2;
					this.#codePoint = byte & 0x0f;
				} else if (byte >= 0xf0 && byte <= 0xf4) {
					if (byte === 0xf0) this.#lower = 0x90;
					if (byte === 0xf4) this.#upper = 0x8f;
					this.#needed = 3;
					this.#codePoint = byte & 0x07;
				} else error();
				continue;
			}
			if (byte < this.#lower || byte > this.#upper) {
				// The sequence so far is one error; this byte starts afresh.
				this.#reset();
				error();
				i--;
				continue;
			}
			this.#lower = 0x80;
			this.#upper = 0xbf;
			this.#codePoint = (this.#codePoint << 6) | (byte & 0x3f);
			this.#seen++;
			if (this.#seen === this.#needed) {
				const point = this.#codePoint;
				this.#reset();
				emit(point);
			}
		}
		if (!stream) {
			if (this.#needed !== 0) {
				this.#reset();
				error();
			}
			this.#start = true;
		}
		if (points.length > 0) out.push(String.fromCodePoint(...points));
		return out.join("");
	}

	#reset(): void {
		this.#needed = 0;
		this.#seen = 0;
		this.#codePoint = 0;
		this.#lower = 0x80;
		this.#upper = 0xbf;
	}
}

/** Put a standard UTF-8 `TextDecoder` in place when the engine has none; true when it did. */
export function installTextDecoder(): boolean {
	if (typeof Reflect.get(globalThis, "TextDecoder") === "function")
		return false;
	Reflect.set(globalThis, "TextDecoder", StandardTextDecoder);
	return true;
}
