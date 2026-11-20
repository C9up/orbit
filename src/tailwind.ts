/**
 * Tailwind classes → native style, split into box props and text props. Text
 * props are what CSS inherits: the template mapping passes them down to the
 * texts below, since native views do not cascade anything.
 *
 * A hand-picked subset for now; it is meant to be compiled from nebula's
 * Tailwind theme at build time. Unknown classes are collected in
 * `unknownClasses` so a screen shows what it lost.
 */
import type { Style } from "./node.js";

const TEXT_KEYS = new Set([
	"color",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"fontFamily",
	"textAlign",
	"lineHeight",
	"letterSpacing",
]);

const COLORS: { [name: string]: { [shade: string]: string } } = {
	slate: {
		"50": "#f8fafc",
		"100": "#f1f5f9",
		"200": "#e2e8f0",
		"300": "#cbd5e1",
		"400": "#94a3b8",
		"500": "#64748b",
		"600": "#475569",
		"700": "#334155",
		"800": "#1e293b",
		"900": "#0f172a",
	},
	blue: {
		"50": "#eff6ff",
		"100": "#dbeafe",
		"500": "#3b82f6",
		"600": "#2563eb",
		"700": "#1d4ed8",
	},
	indigo: {
		"50": "#eef2ff",
		"100": "#e0e7ff",
		"500": "#6366f1",
		"600": "#4f46e5",
		"700": "#4338ca",
	},
	green: {
		"100": "#dcfce7",
		"500": "#22c55e",
		"600": "#16a34a",
		"700": "#15803d",
	},
	red: { "100": "#fee2e2", "500": "#ef4444", "600": "#dc2626" },
	amber: { "100": "#fef3c7", "400": "#fbbf24", "500": "#f59e0b" },
	sky: { "300": "#7dd3fc", "400": "#38bdf8", "500": "#0ea5e9" },
	violet: { "400": "#a78bfa", "500": "#8b5cf6", "600": "#7c3aed" },
	pink: { "400": "#f472b6", "500": "#ec4899" },
	emerald: { "400": "#34d399", "500": "#10b981" },
};

// Tailwind v3 box shadows, first layer: [offsetY, blur, spread, alpha of black].
const SHADOWS: { [k: string]: [number, number, number, number] } = {
	sm: [1, 2, 0, 0.05],
	"": [1, 3, 0, 0.1],
	md: [4, 6, -1, 0.1],
	lg: [10, 15, -3, 0.1],
	xl: [20, 25, -5, 0.1],
	"2xl": [25, 50, -12, 0.25],
};
const BLURS: { [k: string]: number } = {
	sm: 4,
	"": 8,
	md: 12,
	lg: 16,
	xl: 24,
	"2xl": 40,
};

const FONT_SIZES: { [k: string]: number } = {
	xs: 12,
	sm: 14,
	base: 16,
	lg: 18,
	xl: 20,
	"2xl": 24,
	"3xl": 30,
};
const RADII: { [k: string]: number } = {
	none: 0,
	sm: 2,
	"": 4,
	md: 6,
	lg: 8,
	xl: 12,
	"2xl": 16,
	"3xl": 24,
	full: 9999,
};
const WEIGHTS: { [k: string]: string } = {
	normal: "400",
	medium: "500",
	semibold: "600",
	bold: "700",
};

const SPACING: { [prefix: string]: string[] } = {
	p: ["padding"],
	px: ["paddingHorizontal"],
	py: ["paddingVertical"],
	pt: ["paddingTop"],
	pb: ["paddingBottom"],
	pl: ["paddingLeft"],
	pr: ["paddingRight"],
	m: ["margin"],
	mx: ["marginHorizontal"],
	my: ["marginVertical"],
	mt: ["marginTop"],
	mb: ["marginBottom"],
	gap: ["gap"],
	w: ["width"],
	h: ["height"],
	"min-h": ["minHeight"],
	"max-h": ["maxHeight"],
	"min-w": ["minWidth"],
	"max-w": ["maxWidth"],
};

const FIXED: { [cls: string]: Style } = {
	flex: { flexDirection: "row" },
	"flex-row": { flexDirection: "row" },
	"flex-col": { flexDirection: "column" },
	"flex-1": { flex: 1 },
	"flex-wrap": { flexWrap: "wrap" },
	"items-center": { alignItems: "center" },
	"items-start": { alignItems: "flex-start" },
	"items-end": { alignItems: "flex-end" },
	"justify-center": { justifyContent: "center" },
	"justify-between": { justifyContent: "space-between" },
	"justify-end": { justifyContent: "flex-end" },
	"self-start": { alignSelf: "flex-start" },
	"self-end": { alignSelf: "flex-end" },
	"self-center": { alignSelf: "center" },
	// A text field sized by its content (CSS field-sizing), e.g. a composer
	// that grows with its lines up to a max-h-*.
	"field-sizing-content": { fieldSizing: "content" },
	"w-full": { width: "100%" },
	"h-full": { height: "100%" },
	"aspect-square": { aspectRatio: 1 },
	"aspect-video": { aspectRatio: 16 / 9 },
	// How an image fills its box (CSS object-fit; `fill` is CSS's default).
	"object-cover": { objectFit: "cover" },
	"object-contain": { objectFit: "contain" },
	"object-fill": { objectFit: "fill" },
	"object-none": { objectFit: "none" },
	"object-scale-down": { objectFit: "scale-down" },
	border: { borderWidth: 1 },
	"border-2": { borderWidth: 2 },
	"border-white": { borderColor: "#ffffff" },
	"text-center": { textAlign: "center" },
	"text-right": { textAlign: "right" },
	italic: { fontStyle: "italic" },
	"font-mono": { fontFamily: "monospace" },
	"bg-white": { backgroundColor: "#ffffff" },
	"bg-black": { backgroundColor: "#000000" },
	"text-white": { color: "#ffffff" },
	"text-black": { color: "#000000" },
	"opacity-50": { opacity: 0.5 },
	absolute: { position: "absolute" },
	relative: { position: "relative" },
	"inset-0": { top: 0, left: 0, right: 0, bottom: 0 },
	"inset-x-0": { left: 0, right: 0 },
	"top-0": { top: 0 },
	"left-0": { left: 0 },
	"right-0": { right: 0 },
	"bottom-0": { bottom: 0 },
	"overflow-hidden": { overflow: "hidden" },
	// Scrolling is structural on native (a ScrollView), handled by the template renderer.
	"overflow-auto": {},
	"overflow-y-auto": {},
	"overflow-y-scroll": {},
};

export const isScrollContainer = (classes: string) =>
	/(^|\s)overflow-(y-)?(auto|scroll)(\s|$)/.test(classes);

// On the web a scrolling element's padding/gap/flow lay out its content; on
// native those belong to the ScrollView's content container.
const CONTENT_KEYS = new Set([
	"padding",
	"paddingHorizontal",
	"paddingVertical",
	"paddingTop",
	"paddingBottom",
	"paddingLeft",
	"paddingRight",
	"gap",
	"flexDirection",
	"flexWrap",
	"alignItems",
	"justifyContent",
]);

export function splitScroll(box: Style): { outer: Style; content: Style } {
	const outer: Style = {};
	const content: Style = {};
	for (const [key, value] of Object.entries(box))
		(CONTENT_KEYS.has(key) ? content : outer)[key] = value;
	return { outer, content };
}

function color(name: string): string | undefined {
	const dash = name.lastIndexOf("-");
	return COLORS[name.slice(0, dash)]?.[name.slice(dash + 1)];
}

function withAlpha(hex: string, percent: number): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${percent / 100})`;
}

function utility(cls: string): Style | null {
	const fixed = FIXED[cls];
	if (fixed) return fixed;
	const shadow = /^shadow(?:-(sm|md|lg|xl|2xl))?$/.exec(cls);
	if (shadow) {
		const [y, blur, spread, alpha] = SHADOWS[shadow[1] ?? ""] ?? [1, 3, 0, 0.1];
		return {
			shadowY: y,
			shadowBlur: blur,
			shadowSpread: spread,
			shadowColor: `rgba(0, 0, 0, ${alpha})`,
		};
	}
	const backdrop = /^backdrop-blur(?:-(sm|md|lg|xl|2xl))?$/.exec(cls);
	if (backdrop) return { backdropBlur: BLURS[backdrop[1] ?? ""] ?? 8 };
	const position = /^(top|left|right|bottom)-(\d+)$/.exec(cls);
	if (position) return { [position[1] ?? "top"]: Number(position[2]) * 4 };
	const translucent = /^(bg|border|text)-(white|black|[a-z]+-\d+)\/(\d+)$/.exec(
		cls,
	);
	if (translucent) {
		const name = translucent[2] ?? "";
		const hex =
			name === "white" ? "#ffffff" : name === "black" ? "#000000" : color(name);
		if (!hex) return null;
		const key =
			translucent[1] === "bg"
				? "backgroundColor"
				: translucent[1] === "text"
					? "color"
					: "borderColor";
		return { [key]: withAlpha(hex, Number(translucent[3])) };
	}
	const spacing =
		/^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|gap|w|h|min-h|max-h|min-w|max-w)-(\d+(?:\.5)?)$/.exec(
			cls,
		);
	if (spacing) {
		const out: Style = {};
		for (const key of SPACING[spacing[1] ?? ""] ?? [])
			out[key] = Number(spacing[2]) * 4;
		return out;
	}
	const square = /^size-(\d+(?:\.5)?)$/.exec(cls);
	if (square) {
		const side = Number(square[1]) * 4;
		return { width: side, height: side };
	}
	const rounded = /^rounded(?:-(none|sm|md|lg|xl|2xl|3xl|full))?$/.exec(cls);
	if (rounded) return { borderRadius: RADII[rounded[1] ?? ""] ?? 4 };
	const font = /^font-(normal|medium|semibold|bold)$/.exec(cls);
	if (font) return { fontWeight: WEIGHTS[font[1] ?? ""] ?? "400" };
	const size = /^text-(xs|sm|base|lg|xl|2xl|3xl)$/.exec(cls);
	if (size) return { fontSize: FONT_SIZES[size[1] ?? ""] ?? 16 };
	const colored = /^(bg|text|border)-([a-z]+-\d+)$/.exec(cls);
	if (colored) {
		const value = color(colored[2] ?? "");
		if (!value) return null;
		const key =
			colored[1] === "bg"
				? "backgroundColor"
				: colored[1] === "text"
					? "color"
					: "borderColor";
		return { [key]: value };
	}
	return null;
}

export type SplitStyle = { box: Style; text: Style };

const cache = new Map<string, SplitStyle>();
export const unknownClasses = new Set<string>();

export function tw(classes: string): SplitStyle {
	const hit = cache.get(classes);
	if (hit) return hit;
	const out: SplitStyle = { box: {}, text: {} };
	for (const cls of classes.split(/\s+/)) {
		if (!cls) continue;
		const style = utility(cls);
		if (!style) {
			unknownClasses.add(cls);
			continue;
		}
		for (const [key, value] of Object.entries(style)) {
			(TEXT_KEYS.has(key) ? out.text : out.box)[key] = value;
		}
	}
	cache.set(classes, out);
	return out;
}
