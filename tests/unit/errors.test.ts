import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("orbit > errors", () => {
	it("exports one class per code, each a flare Exception", () => {
		const error = new errors.E_ORBIT_UNKNOWN_PAGE(["Orders"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error.code).toBe("E_ORBIT_UNKNOWN_PAGE");
		expect(error.status).toBe(500);
		expect(error.message).toBe(
			'[orbit] the server named the page "Orders", which this app does not have',
		);
	});

	it("keeps the platform's error class for the URL and TextDecoder stand-ins", () => {
		const url = new errors.E_ORBIT_INVALID_URL("Invalid URL: x");
		expect(url).toBeInstanceOf(TypeError);
		expect(url.name).toBe("TypeError");
		expect(url.code).toBe("E_ORBIT_INVALID_URL");
		const encoding = new errors.E_ORBIT_UNSUPPORTED_ENCODING("latin1");
		expect(encoding).toBeInstanceOf(RangeError);
		expect(encoding.code).toBe("E_ORBIT_UNSUPPORTED_ENCODING");
	});
});
