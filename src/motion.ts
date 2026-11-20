import { OrbitError } from "./errors.js";
import { currentHost } from "./host.js";

/**
 * Animation that runs on the UI thread, driven by the Rust host on every
 * vsync: JS declares values, curves and bindings once, and a blocked JS
 * thread stops none of it. aurora's DOM renderer is meant to offer the same
 * shape on the web.
 */

let nextNodeTag = 1;

/** A value that can feed a style property: a motion value or an interpolation of one. */
export class MotionNode {
	constructor(readonly tag: number) {}

	/** Linear map from `input` to `output`, clamped at both ends. */
	interpolate(input: readonly number[], output: readonly number[]): MotionNode {
		const tag = nextNodeTag++;
		currentHost().motionInterpolate(tag, this.tag, input, output);
		return new MotionNode(tag);
	}
}

const easeInOut = (t: number) =>
	t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

export type TimingOptions = {
	duration?: number;
	loop?: boolean;
	yoyo?: boolean;
};
export type SpringOptions = {
	stiffness?: number;
	damping?: number;
	mass?: number;
};

export class MotionValue extends MotionNode {
	constructor(initial: number) {
		const tag = nextNodeTag++;
		currentHost().motionValue(tag, initial);
		super(tag);
	}

	set(value: number): void {
		currentHost().motionSet(this.tag, value);
	}

	stop(): void {
		currentHost().motionStop(this.tag);
	}

	/**
	 * Eased tween to `to`. The curve is sampled once into 60 Hz frames; the
	 * host plays them on the UI thread.
	 */
	timing(
		to: number,
		{ duration = 300, loop = false, yoyo = false }: TimingOptions = {},
	): void {
		const count = Math.max(1, Math.round(duration / (1000 / 60)));
		const frames: number[] = [];
		for (let i = 0; i <= count; i++) frames.push(easeInOut(i / count));
		if (yoyo) for (let i = count - 1; i >= 0; i--) frames.push(frames[i] ?? 0);
		currentHost().motionFrames(this.tag, frames, to, loop);
	}

	spring(
		to: number,
		{ stiffness = 180, damping = 12, mass = 1 }: SpringOptions = {},
	): void {
		currentHost().motionSpring(this.tag, to, stiffness, damping, mass);
	}
}

/** Style properties a motion binding may drive. */
export type MotionStyle = {
	opacity?: MotionNode;
	translateX?: MotionNode;
	translateY?: MotionNode;
	scale?: MotionNode;
};

const PROPS = { opacity: 0, translateX: 1, translateY: 2, scale: 3 } as const;
const KEYS = ["opacity", "translateX", "translateY", "scale"] as const;

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

/** Read a `motion=${…}` attribute value. */
export function readMotion(value: unknown): MotionStyle {
	if (typeof value !== "object" || value === null) {
		throw new OrbitError(
			"E_ORBIT_INVALID_MOTION",
			"[orbit] motion expects an object of motion values",
		);
	}
	const out: MotionStyle = {};
	for (const key of KEYS) {
		const node: unknown = Reflect.get(value, key);
		if (node instanceof MotionNode) out[key] = node;
		else if (node !== undefined) {
			throw new OrbitError(
				"E_ORBIT_INVALID_MOTION",
				`[orbit] motion.${key} must be a motion value`,
			);
		}
	}
	return out;
}
