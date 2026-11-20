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
	/** An element with no native mapping yet (`<input>`, `<img>`, `<svg>`…). */
	| "E_ORBIT_UNSUPPORTED_ELEMENT"
	/** A block element inside text: native text holds only inline runs. */
	| "E_ORBIT_BLOCK_IN_TEXT"
	/** `motion=${…}` was not an object of motion values. */
	| "E_ORBIT_INVALID_MOTION"
	/** `scroll-y=${…}` was not a motion value. */
	| "E_ORBIT_INVALID_SCROLL_BINDING"
	/** A colour orbit cannot read (named colours other than `transparent`, `hsl()`…). */
	| "E_ORBIT_INVALID_COLOR";

export class OrbitError extends Error {
	readonly code: OrbitErrorCode;

	constructor(code: OrbitErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}
