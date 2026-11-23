import type { Exception } from "@c9up/flare";
import { E_ORBIT_INVALID_COLOR } from "./errors.js";

/**
 * A CSS colour as the 32-bit ARGB integer the native host reads (signed, as
 * Android's `Color` int), without React Native's `processColor`: the core of
 * orbit runs and is tested without React Native.
 *
 * Reads `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` with
 * comma or space syntax, and `transparent`.
 */
export function colorToArgb(css: string): number {
	const value = css.trim().toLowerCase();
	if (value === "transparent") return 0;
	if (value.startsWith("#")) return fromHex(value.slice(1), css);
	const fn = /^rgba?\(\s*([^)]+)\)$/.exec(value);
	if (fn) return fromRgb(fn[1] ?? "", css);
	throw new E_ORBIT_INVALID_COLOR([css]);
}

function pack(r: number, g: number, b: number, a: number): number {
	const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
	return (byte(a) << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b) | 0;
}

function fromHex(hex: string, css: string): number {
	if (!/^[0-9a-f]+$/.test(hex)) throw invalid(css);
	const at = (i: number, len: number) =>
		Number.parseInt(
			len === 1 ? hex.charAt(i).repeat(2) : hex.slice(i, i + 2),
			16,
		);
	switch (hex.length) {
		case 3:
			return pack(at(0, 1), at(1, 1), at(2, 1), 255);
		case 4:
			return pack(at(0, 1), at(1, 1), at(2, 1), at(3, 1));
		case 6:
			return pack(at(0, 2), at(2, 2), at(4, 2), 255);
		case 8:
			return pack(at(0, 2), at(2, 2), at(4, 2), at(6, 2));
		default:
			throw invalid(css);
	}
}

function fromRgb(args: string, css: string): number {
	const parts = args.split(/[\s,/]+/).filter(Boolean);
	if (parts.length !== 3 && parts.length !== 4) throw invalid(css);
	const channel = (p: string) =>
		p.endsWith("%") ? (Number.parseFloat(p) * 255) / 100 : Number.parseFloat(p);
	const alpha = (p: string | undefined) => {
		if (p === undefined) return 255;
		return (
			(p.endsWith("%") ? Number.parseFloat(p) / 100 : Number.parseFloat(p)) *
			255
		);
	};
	const [r, g, b] = parts.map(channel);
	const a = alpha(parts[3]);
	if ([r, g, b, a].some((n) => n === undefined || Number.isNaN(n)))
		throw invalid(css);
	return pack(r ?? 0, g ?? 0, b ?? 0, a);
}

function invalid(css: string): Exception {
	return new E_ORBIT_INVALID_COLOR([css]);
}
