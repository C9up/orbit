/**
 * Orbit's errors, one per code. Every failure carries a stable
 * `E_ORBIT_<REASON>` code, so a caller branches on `error.code` or on
 * `instanceof errors.E_ORBIT_…` rather than on a message.
 */
import { createError } from "@c9up/flare";

/** `mount` ran before `useHost` gave orbit a native host, or the module is not orbit's host. */
export const E_ORBIT_NO_HOST = createError<[string]>(
	"[orbit] %s",
	"E_ORBIT_NO_HOST",
);

/** The native host refused a commit; the message carries its report. */
export const E_ORBIT_COMMIT_FAILED = createError<[unknown]>(
	"[orbit] the host refused a commit: %j",
	"E_ORBIT_COMMIT_FAILED",
);

/** An element with no native mapping yet (`<select>`, `<canvas>`, or `<text>` / a gradient inside an `<svg>`). */
export const E_ORBIT_UNSUPPORTED_ELEMENT = createError<[string, string]>(
	"[orbit] <%s> %s",
	"E_ORBIT_UNSUPPORTED_ELEMENT",
);

/** A block element inside text: native text holds only inline runs. */
export const E_ORBIT_BLOCK_IN_TEXT = createError<[string]>(
	"[orbit] <%s> cannot sit inside text on native",
	"E_ORBIT_BLOCK_IN_TEXT",
);

/** `motion=${…}` was not an object of motion values. The message is aurora's. */
export const E_ORBIT_INVALID_MOTION = createError<[string]>(
	"%s",
	"E_ORBIT_INVALID_MOTION",
);

/** `scroll-y=${…}` was not a motion value. */
export const E_ORBIT_INVALID_SCROLL_BINDING = createError(
	"[orbit] scroll-y expects a motion value",
	"E_ORBIT_INVALID_SCROLL_BINDING",
);

/** A colour orbit cannot read (named colours other than `transparent`, `hsl()`…). */
export const E_ORBIT_INVALID_COLOR = createError<[string]>(
	'[orbit] cannot read the colour "%s"',
	"E_ORBIT_INVALID_COLOR",
);

/** `<img src>` over plain http: images are fetched over https only. */
export const E_ORBIT_INSECURE_IMAGE_URL = createError<[string]>(
	'[orbit] <img src="%s">: an image is fetched over https only',
	"E_ORBIT_INSECURE_IMAGE_URL",
);

/** `<img src>` with a scheme that is not an image source (`data:`, `javascript:`…). */
export const E_ORBIT_IMAGE_SOURCE = createError<[string, string]>(
	'[orbit] <img src="%s">: %s',
	"E_ORBIT_IMAGE_SOURCE",
);

/** Two elements of an `each` list share a key: a key names one row. */
export const E_ORBIT_DUPLICATE_KEY = createError<[string]>(
	"[orbit] each(): two elements share the key %s — a key names one row",
	"E_ORBIT_DUPLICATE_KEY",
);

/** `useScreen()` in a component no screen of a stack built. */
export const E_ORBIT_NO_SCREEN = createError(
	"[orbit] useScreen() outside a screen: it reads the screen a stack shows, from a component that screen built",
	"E_ORBIT_NO_SCREEN",
);

/** One stack put in two places: a stack is shown once. */
export const E_ORBIT_STACK_SHOWN = createError(
	"[orbit] a stack is shown in one place: this one is already in a template",
	"E_ORBIT_STACK_SHOWN",
);

/** `useStyles` got something other than a table `ream css:compile` wrote. */
export const E_ORBIT_STYLE_TABLE = createError(
	"[orbit] not a style table orbit reads (version 1, from ream css:compile)",
	"E_ORBIT_STYLE_TABLE",
);

/** `serverPages({ server })` over plain http to a host that is not this machine or the emulator's. */
export const E_ORBIT_INSECURE_SERVER = createError<[string]>(
	"[orbit] the server %s is not https (plain http only reaches this machine or the emulator's host)",
	"E_ORBIT_INSECURE_SERVER",
);

/** The server named a page the app does not have (`serverPages({ pages })`). */
export const E_ORBIT_UNKNOWN_PAGE = createError<[string]>(
	'[orbit] the server named the page "%s", which this app does not have',
	"E_ORBIT_UNKNOWN_PAGE",
);

/** A server connection was asked for a path that resolves to another origin. */
export const E_ORBIT_FOREIGN_ORIGIN = createError<[string, string]>(
	"[orbit] the connection to %s does not reach %s",
	"E_ORBIT_FOREIGN_ORIGIN",
);

/** The server answered a JSON request with an empty non-2xx response. */
export const E_ORBIT_SERVER_REQUEST_FAILED = createError<[string, number]>(
	"[orbit] %s answered HTTP %d",
	"E_ORBIT_SERVER_REQUEST_FAILED",
);

/** Server events need an `XMLHttpRequest`, and the platform has none. */
export const E_ORBIT_NO_XHR = createError(
	"[orbit] server events need XMLHttpRequest",
	"E_ORBIT_NO_XHR",
);

/** An invariant inside orbit broke: a bug in orbit. The site says which one. */
export const E_ORBIT_INTERNAL = createError<[string]>(
	"[orbit] %s",
	"E_ORBIT_INTERNAL",
);

// The errors below are raised by orbit's stand-ins for the platform's `URL`
// and `TextDecoder`, which Hermes lacks. Code written against those APIs
// expects what the WHATWG specs raise — `new URL("bad")` throws a `TypeError`,
// an unknown encoding label a `RangeError` — so these stay native error
// classes, named like the platform's own (`name` is `TypeError` /
// `RangeError`), with the code added. They are not flare exceptions on
// purpose: a polyfill must not change what the API it replaces throws.

/** `URL.createObjectURL` with no platform `URL` to make blob URLs. */
export class E_ORBIT_OBJECT_URL_UNAVAILABLE extends TypeError {
	static readonly code = "E_ORBIT_OBJECT_URL_UNAVAILABLE";
	readonly code = "E_ORBIT_OBJECT_URL_UNAVAILABLE";
}

/** A URL (or its base) that does not parse. */
export class E_ORBIT_INVALID_URL extends TypeError {
	static readonly code = "E_ORBIT_INVALID_URL";
	readonly code = "E_ORBIT_INVALID_URL";
}

/** `TextDecoder` given an encoding label other than UTF-8's. */
export class E_ORBIT_UNSUPPORTED_ENCODING extends RangeError {
	static readonly code = "E_ORBIT_UNSUPPORTED_ENCODING";
	readonly code = "E_ORBIT_UNSUPPORTED_ENCODING";
}

/** `TextDecoder.decode` given something that is not an `ArrayBuffer` or a view on one. */
export class E_ORBIT_INVALID_DECODER_INPUT extends TypeError {
	static readonly code = "E_ORBIT_INVALID_DECODER_INPUT";
	readonly code = "E_ORBIT_INVALID_DECODER_INPUT";
}

/** A `fatal` `TextDecoder` met bytes that are not valid UTF-8. */
export class E_ORBIT_INVALID_ENCODED_DATA extends TypeError {
	static readonly code = "E_ORBIT_INVALID_ENCODED_DATA";
	readonly code = "E_ORBIT_INVALID_ENCODED_DATA";
}
