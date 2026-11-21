/**
 * The part of React Native's JS API orbit's app entry uses — declared here so
 * orbit builds without React Native installed. An app has the real package;
 * this file is not part of what orbit's declarations reference.
 */
declare module "react-native" {
	export const AppRegistry: {
		registerRunnable(
			name: string,
			run: (params: { initialProps?: { [key: string]: unknown } }) => void,
		): void;
	};
	export const Dimensions: {
		get(dimension: "window"): { width: number; height: number };
	};
	export const TurboModuleRegistry: {
		getEnforcing(name: string): unknown;
	};
}
