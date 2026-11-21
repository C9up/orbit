/**
 * `@c9up/orbit/react-native` — an app's entry on a phone.
 *
 *     import { run } from "@c9up/orbit/react-native";
 *     import { App } from "./App.js";
 *     run(App);
 *
 * React Native supplies the JS engine, the JSI module registry and the
 * activity; nothing of React is used. `run` registers the app under the name
 * the activity `ream android:*` generates starts, gives orbit its native host
 * and the app's style table, and mounts the root component with the launch
 * props (intent extras). The
 * back button and the back gesture pop the innermost shown stack; with none
 * to pop, the app goes back as any Android app does. React Native's `URL` is
 * replaced by a standard one when it is not one (see `url.ts`).
 */
import type { TemplateResult } from "@c9up/aurora/renderer";
// The app's style table: `ream android:*` compiles the app's Tailwind build
// into it and Metro serves it under this name.
import styles from "@c9up/orbit-styles";
import {
	Appearance,
	AppRegistry,
	BackHandler,
	Dimensions,
	TurboModuleRegistry,
} from "react-native";
import { OrbitError } from "../errors.js";
import { NATIVE_MODULE_NAME, type OrbitHost, useHost } from "../host.js";
import { goBack } from "../stack.js";
import { colorScheme, useStyles } from "../styles.js";
import { mount } from "../template.js";
import { installTextDecoder } from "../textDecoder.js";
import { installStandardUrl } from "../url.js";

// Before the app's own modules run: React Native's URL resolves a relative
// reference by appending it to the base, and photon's router (and any code
// shared with the browser) needs the standard one.
installStandardUrl();
// Hermes has TextEncoder but no TextDecoder: libraries shared with the web
// (msgpack, protobuf…) would die at load.
installTextDecoder();

/** The name the generated activity starts the app by. */
export const APP_NAME = "main";

export type LaunchProps = { [key: string]: unknown };

const METHODS: ReadonlyArray<keyof OrbitHost> = [
	"setViewport",
	"commit",
	"imageBytes",
	"layout",
	"scroll",
	"setEventHandler",
];

function isOrbitHost(value: unknown): value is OrbitHost {
	return (
		typeof value === "object" &&
		value !== null &&
		METHODS.every((name) => typeof Reflect.get(value, name) === "function")
	);
}

export interface RunOptions {
	/**
	 * `system` (default): `dark:` follows the phone's setting, as a browser's
	 * `prefers-color-scheme` — until the app sets `colorScheme(…)` itself.
	 * `light` / `dark`: that one, whatever the phone says.
	 */
	colorScheme?: "system" | "light" | "dark";
}

/**
 * Follow the phone's light / dark setting into `colorScheme`, as long as the
 * app has not chosen one itself (a value set by anything else stops it).
 */
function followSystemScheme(): void {
	const read = (
		value: "light" | "dark" | null | undefined,
	): "light" | "dark" => (value === "dark" ? "dark" : "light");
	let set = read(Appearance.getColorScheme());
	colorScheme(set);
	const subscription = Appearance.addChangeListener(({ colorScheme: next }) => {
		if (colorScheme() !== set) {
			subscription.remove();
			return;
		}
		set = read(next);
		colorScheme(set);
	});
}

/** Register `root` as the app and mount it when the activity starts. */
export function run(
	root: (props: LaunchProps) => TemplateResult,
	options: RunOptions = {},
): void {
	AppRegistry.registerRunnable(APP_NAME, ({ initialProps }) => {
		const host = TurboModuleRegistry.getEnforcing(NATIVE_MODULE_NAME);
		if (!isOrbitHost(host)) {
			throw new OrbitError(
				"E_ORBIT_NO_HOST",
				`[orbit] the ${NATIVE_MODULE_NAME} module is not orbit's native host: is the app built by ream android:build?`,
			);
		}
		useHost(host);
		useStyles(styles);
		const scheme = options.colorScheme ?? "system";
		if (scheme === "system") followSystemScheme();
		else colorScheme(scheme);
		BackHandler.addEventListener("hardwareBackPress", goBack);
		mount(root(initialProps ?? {}), { viewport: Dimensions.get("window") });
	});
}
