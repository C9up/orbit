/**
 * Orbit's errors.
 *
 * Every failure carries a stable `code` (`E_ORBIT_<REASON>`), so a caller
 * branches on what went wrong rather than on a message.
 */

export type OrbitErrorCode =
	/** `mount` ran before `useHost` gave orbit a native host. */
	| "E_ORBIT_NO_HOST"
	/** The native host refused a commit; the message carries its report. */
	| "E_ORBIT_COMMIT_FAILED"
	/** An element with no native mapping yet (`<select>`, `<svg>`, `<canvas>`…). */
	| "E_ORBIT_UNSUPPORTED_ELEMENT"
	/** A block element inside text: native text holds only inline runs. */
	| "E_ORBIT_BLOCK_IN_TEXT"
	/** `motion=${…}` was not an object of motion values. */
	| "E_ORBIT_INVALID_MOTION"
	/** `scroll-y=${…}` was not a motion value. */
	| "E_ORBIT_INVALID_SCROLL_BINDING"
	/** A colour orbit cannot read (named colours other than `transparent`, `hsl()`…). */
	| "E_ORBIT_INVALID_COLOR"
	/** `<img src>` over plain http: images are fetched over https only. */
	| "E_ORBIT_INSECURE_IMAGE_URL"
	/** `<img src>` with a scheme that is not an image source (`data:`, `javascript:`…). */
	| "E_ORBIT_IMAGE_SOURCE"
	/** Two elements of an `each` list share a key: a key names one row. */
	| "E_ORBIT_DUPLICATE_KEY"
	/** `useScreen()` in a component no screen of a stack built. */
	| "E_ORBIT_NO_SCREEN"
	/** One stack put in two places: a stack is shown once. */
	| "E_ORBIT_STACK_SHOWN"
	/** `useStyles` got something other than a table `ream css:compile` wrote. */
	| "E_ORBIT_STYLE_TABLE";

export class OrbitError extends Error {
	readonly code: OrbitErrorCode;

	constructor(code: OrbitErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}
