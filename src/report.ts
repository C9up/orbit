/**
 * Where orbit tells the app about a failure it recovered from instead of
 * throwing: a commit the host refused while nobody was waiting on it (a
 * scheduled commit), an image address from data orbit will not load, a value
 * in a drawing the host left out. `mount({ onError })` sets the listener; with
 * none, a development build (React Native's `__DEV__`) logs it with
 * `console.warn` and a production build says nothing.
 */

export type ErrorListener = (error: Error) => void;

let listener: ErrorListener | null = null;

/** The listener `mount` was given (null: the default described above). */
export function setErrorListener(next: ErrorListener | null): void {
	listener = next;
}

export function report(error: Error): void {
	if (listener) {
		listener(error);
		return;
	}
	if (Reflect.get(globalThis, "__DEV__") === true) console.warn(error);
}
