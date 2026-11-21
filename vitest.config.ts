import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// orbit's app entry imports React Native, which only an app installs.
		alias: {
			"react-native": fileURLToPath(
				new URL("./tests/unit/reactNative.ts", import.meta.url),
			),
			"@c9up/orbit-styles": fileURLToPath(
				new URL("./tests/styles/table.json", import.meta.url),
			),
		},
	},
	test: {
		setupFiles: ["tests/unit/setup.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 85,
				statements: 85,
				branches: 80,
				functions: 85,
			},
		},
	},
});
