/**
 * The part of React Native's JS API orbit's app entry uses — declared here so
 * orbit builds without React Native installed. An app has the real package;
 * this file is not part of what orbit's declarations reference.
 */
/** The app's style table, which `ream android:*`'s Metro config provides. */
declare module "@c9up/orbit-styles" {
	const table: unknown;
	export default table;
}

declare module "react-native" {
	export const AppRegistry: {
		registerRunnable(
			name: string,
			run: (params: { initialProps?: { [key: string]: unknown } }) => void,
		): void;
	};
	export const BackHandler: {
		addEventListener(
			event: "hardwareBackPress",
			handler: () => boolean,
		): { remove(): void };
	};
	export const Dimensions: {
		get(dimension: "window"): { width: number; height: number };
	};
	export const Appearance: {
		getColorScheme(): "light" | "dark" | null | undefined;
		addChangeListener(
			listener: (preferences: {
				colorScheme: "light" | "dark" | null | undefined;
			}) => void,
		): { remove(): void };
	};
	export const TurboModuleRegistry: {
		getEnforcing(name: string): unknown;
	};
}
