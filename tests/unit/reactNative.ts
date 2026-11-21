/** Stands in for React Native in tests: records what orbit's app entry registers. */
type Run = (params: { initialProps?: { [key: string]: unknown } }) => void;

export const registered = new Map<string, Run>();
export const modules = new Map<string, unknown>();

export const AppRegistry = {
	registerRunnable(name: string, run: Run): void {
		registered.set(name, run);
	},
};

/** What the app asked to hear of the back button; `back()` presses it. */
export const backHandlers: Array<() => boolean> = [];

export const BackHandler = {
	addEventListener(_event: "hardwareBackPress", handler: () => boolean) {
		backHandlers.push(handler);
		return {
			remove() {
				backHandlers.splice(backHandlers.indexOf(handler), 1);
			},
		};
	},
};

/** Press back: true when the app handled it, false when the platform would. */
export function back(): boolean {
	for (let i = backHandlers.length - 1; i >= 0; i--)
		if (backHandlers[i]?.()) return true;
	return false;
}

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
