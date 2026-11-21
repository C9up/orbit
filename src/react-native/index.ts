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
 * to pop, the app goes back as any Android app does.
 */
import type { TemplateResult } from "@c9up/aurora/renderer";
// The app's style table: `ream android:*` compiles the app's Tailwind build
// into it and Metro serves it under this name.
import styles from "@c9up/orbit-styles";
import {
	AppRegistry,
	BackHandler,
	Dimensions,
	TurboModuleRegistry,
} from "react-native";
import { OrbitError } from "../errors.js";
import { NATIVE_MODULE_NAME, type OrbitHost, useHost } from "../host.js";
import { goBack } from "../stack.js";
import { useStyles } from "../styles.js";
import { mount } from "../template.js";

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

/** Register `root` as the app and mount it when the activity starts. */
export function run(root: (props: LaunchProps) => TemplateResult): void {
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
		BackHandler.addEventListener("hardwareBackPress", goBack);
		mount(root(initialProps ?? {}), { viewport: Dimensions.get("window") });
	});
}
