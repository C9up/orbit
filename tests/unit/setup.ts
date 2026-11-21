import { useStyles } from "../../src/index.js";
import table from "../styles/table.json" with { type: "json" };

// The app's stylesheet, as `ream android:*` hands it over (scripts/test-styles.mjs).
useStyles(table);
