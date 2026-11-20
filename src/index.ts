/**
 * `@c9up/orbit` — aurora components as native views on a phone.
 *
 * The JS side keeps a tree of native nodes that aurora's signals patch; each
 * commit goes over JSI to a Rust host that lays it out (taffy), diffs it and
 * hands mount operations to the platform's views. Animations and scroll-driven
 * values run on the UI thread, without JS.
 *
 *   useHost(TurboModuleRegistry.getEnforcing("NativeOrbit"))
 *   mount(App(), { viewport: Dimensions.get("window") })
 */

export { colorToArgb } from "./color.js";
export {
	afterCommit,
	type MountOptions,
	type OrbitReport,
	type Root,
} from "./commit.js";
export { OrbitError, type OrbitErrorCode } from "./errors.js";
export { NATIVE_MODULE_NAME, type OrbitHost, useHost } from "./host.js";
export {
	bindMotion,
	bindScrollY,
	MotionNode,
	type MotionStyle,
	MotionValue,
	type SpringOptions,
	type TimingOptions,
} from "./motion.js";
export { unknownClasses } from "./tailwind.js";
export { mount } from "./template.js";
