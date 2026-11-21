/**
 * Rebuild the style table orbit's unit tests use: Tailwind over the tests
 * (tests/styles/app.css), then `ream css:compile`, as `ream android:*` does
 * for an app. Run after adding a class to a test.
 *
 *     node scripts/test-styles.mjs            # `ream` from PATH
 *     REAM=/path/to/ream node scripts/test-styles.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "orbit-styles-"));
const css = join(scratch, "app.css");
try {
	execFileSync(
		join(root, "node_modules", ".bin", "tailwindcss"),
		["-i", join(root, "tests", "styles", "app.css"), "-o", css],
		{ stdio: "inherit", cwd: root },
	);
	execFileSync(
		process.env.REAM ?? "ream",
		["css:compile", css, "-o", join(root, "tests", "styles", "table.json")],
		{ stdio: "inherit" },
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
