/** Stands in for React Native in tests: records what orbit's app entry registers. */
type Run = (params: { initialProps?: { [key: string]: unknown } }) => void;

export const registered = new Map<string, Run>();
export const modules = new Map<string, unknown>();

export const AppRegistry = {
	registerRunnable(name: string, run: Run): void {
		registered.set(name, run);
	},
};

export const Dimensions = {
	get(_dimension: "window") {
		return { width: 360, height: 640 };
	},
};

export const TurboModuleRegistry = {
	getEnforcing(name: string): unknown {
		if (!modules.has(name))
			throw new Error(`TurboModuleRegistry: ${name} not found`);
		return modules.get(name);
	},
};
