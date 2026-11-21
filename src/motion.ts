/**
 * Motion values on the phone: aurora's `MotionValue`, driven by the Rust host
 * on the UI thread. JS declares values, curves and bindings once, and a
 * blocked JS thread stops none of it. The same component file animates in the
 * browser, where aurora's DOM renderer hands the curves to the Web Animations
 * API.
 */
import {
	AuroraError,
	type MotionDriver,
	type MotionStyle,
	type MotionValue,
	readMotionStyle,
	setMotionDriver,
} from "@c9up/aurora/core";
import { OrbitError } from "./errors.js";
import { currentHost } from "./host.js";

export {
	MotionNode,
	type MotionStyle,
	MotionValue,
	type SpringOptions,
	type TimingOptions,
} from "@c9up/aurora/core";

/** aurora's motion values, held and played by orbit's native host. */
const nativeDriver: MotionDriver = {
	value: (tag, initial) => currentHost().motionValue(tag, initial),
	set: (tag, value) => currentHost().motionSet(tag, value),
	stop: (tag) => currentHost().motionStop(tag),
	frames: (tag, frames, to, loop) =>
		currentHost().motionFrames(tag, [...frames], to, loop),
	spring: (tag, to, stiffness, damping, mass) =>
		currentHost().motionSpring(tag, to, stiffness, damping, mass),
	interpolate: (tag, input, from, to) =>
		currentHost().motionInterpolate(tag, input, from, to),
	dispose: (tag) => currentHost().motionDispose(tag),
};

/** @internal `useHost` installs it: motion values made from then on live in the host. */
export function useNativeMotion(): void {
	setMotionDriver(nativeDriver);
}

const PROPS = {
	opacity: 0,
	translateX: 1,
	translateY: 2,
	scale: 3,
	visible: 4,
} as const;
const KEYS = [
	"opacity",
	"translateX",
	"translateY",
	"scale",
	"visible",
] as const;

/** Wire `style` to the view `viewTag`; call once the view is committed. */
export function bindMotion(viewTag: number, style: MotionStyle): void {
	for (const key of KEYS) {
		const node = style[key];
		if (node) currentHost().motionBind(viewTag, PROPS[key], node.tag);
	}
}

/** Feed `value` from the scroll offset of the scroll view `scrollViewTag`. */
export function bindScrollY(scrollViewTag: number, value: MotionValue): void {
	currentHost().motionBindScroll(scrollViewTag, value.tag);
}

/** Read a `motion=${…}` attribute value, as aurora reads it on the web. */
export function readMotion(value: unknown): MotionStyle {
	try {
		return readMotionStyle(value);
	} catch (error) {
		if (error instanceof AuroraError) {
			throw new OrbitError("E_ORBIT_INVALID_MOTION", error.message, {
				cause: error,
			});
		}
		throw error;
	}
}
