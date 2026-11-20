import { OrbitError } from "./errors.js";

/**
 * What orbit needs from the native side: the Rust host behind JSI (the
 * `NativeOrbit` TurboModule, see `specs/NativeOrbit.ts`), or a fake in tests.
 * Structural on purpose: orbit's core imports nothing from React Native.
 */
export interface OrbitHost {
	/** The root's size in dp. */
	setViewport(width: number, height: number): void;
	/** Apply a JSON batch of tree operations; returns the host's JSON report. */
	commit(ops: string): string;
	/**
	 * Events from host views: touches (React Native's touch event types, in dp),
	 * text fields (`topChange`, `topFocus`, `topBlur`, `topSubmit`, with the
	 * text in `data`), and `topViewport` on tag 0 when the window resized (the
	 * keyboard), with `x`/`y` the new size in dp.
	 */
	setEventHandler(
		handler: (
			tag: number,
			type: string,
			x: number,
			y: number,
			data: string,
		) => void,
	): void;
	motionValue(tag: number, initial: number): void;
	motionInterpolate(
		tag: number,
		input: number,
		from: readonly number[],
		to: readonly number[],
	): void;
	motionSet(tag: number, value: number): void;
	motionStop(tag: number): void;
	motionFrames(
		tag: number,
		frames: readonly number[],
		to: number,
		loop: boolean,
	): void;
	motionSpring(
		tag: number,
		to: number,
		stiffness: number,
		damping: number,
		mass: number,
	): void;
	/** prop: 0 opacity, 1 translateX, 2 translateY, 3 scale. */
	motionBind(view: number, prop: number, node: number): void;
	motionBindScroll(scrollView: number, value: number): void;
}

/** The TurboModule name the native side registers. */
export const NATIVE_MODULE_NAME = "NativeOrbit";

let host: OrbitHost | null = null;

/** Give orbit its native host, once, before `mount`. */
export function useHost(next: OrbitHost): void {
	host = next;
}

export function currentHost(): OrbitHost {
	if (host === null) {
		throw new OrbitError(
			"E_ORBIT_NO_HOST",
			`[orbit] no native host: call useHost(TurboModuleRegistry.getEnforcing("${NATIVE_MODULE_NAME}")) before mount()`,
		);
	}
	return host;
}
