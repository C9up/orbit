import { each, html, signal } from "@c9up/aurora/core";
import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors, mount, useHost } from "../../src/index.js";
import { FakeHost } from "./fakeHost.js";

const viewport = { width: 400, height: 800 };

function setup(): FakeHost {
	const host = new FakeHost();
	useHost(host);
	return host;
}

function image(host: FakeHost) {
	const entry = host.all("OrbitImage")[0];
	if (!entry) throw new Error("no image");
	return { tag: entry[0], node: entry[1] };
}

function srcOf(markup: ReturnType<typeof html>): unknown {
	const host = setup();
	mount(html`<div>${markup}</div>`, { viewport });
	return image(host).node.props.src;
}

function errorCode(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof Exception) return error.code;
		throw error;
	}
	return undefined;
}

describe("images", () => {
	it("maps an img with its box classes, fit and alt", () => {
		const host = setup();
		mount(
			html`<div><img src="https://cdn.example.com/a.jpg" alt="Portrait" class="size-16 rounded-full object-cover" /></div>`,
			{ viewport },
		);
		expect(image(host).node.props).toEqual({
			width: 64,
			height: 64,
			// calc(infinity * 1px), clamped to the box when drawn.
			borderRadius: 1000000,
			objectFit: "cover",
			// Tailwind's preflight: an image never overflows its container.
			maxWidth: "100%",
			src: "https://cdn.example.com/a.jpg",
			alt: "Portrait",
		});
	});

	it("sizes by aspect ratio against a full width", () => {
		const host = setup();
		mount(
			html`<div><img src="hero.png" class="w-full aspect-video object-contain" /></div>`,
			{ viewport },
		);
		expect(image(host).node.props).toMatchObject({
			width: "100%",
			aspectRatio: 16 / 9,
			objectFit: "contain",
		});
	});

	it("reads a path as a file and a bare name as a bundled asset", () => {
		expect(srcOf(html`<img src="/data/user/0/app/files/a.jpg" />`)).toBe(
			"file:/data/user/0/app/files/a.jpg",
		);
		expect(srcOf(html`<img src="file:///data/a%20b.jpg" />`)).toBe(
			"file:/data/a b.jpg",
		);
		expect(srcOf(html`<img src="./images/logo.png" />`)).toBe(
			"asset:images/logo.png",
		);
		expect(srcOf(html`<img src="content://media/external/images/7" />`)).toBe(
			"content://media/external/images/7",
		);
		expect(srcOf(html`<img src="" />`)).toBe("");
	});

	it("refuses http and any scheme that is not an image source", () => {
		expect(
			errorCode(() => srcOf(html`<img src="http://example.com/a.jpg" />`)),
		).toBe("E_ORBIT_INSECURE_IMAGE_URL");
		expect(
			errorCode(() => srcOf(html`<img src="javascript:alert(1)" />`)),
		).toBe("E_ORBIT_IMAGE_SOURCE");
		expect(
			errorCode(() => srcOf(html`<img src="data:image/png;base64,AAAA" />`)),
		).toBe("E_ORBIT_IMAGE_SOURCE");
		expect(errorCode(() => srcOf(html`<img src="file:///a%E0.jpg" />`))).toBe(
			"E_ORBIT_IMAGE_SOURCE",
		);
	});

	it("refuses a scheme-relative address, and quotes a long one cut", () => {
		expect(
			errorCode(() => srcOf(html`<img src="//cdn.example.org/u/2.png" />`)),
		).toBe("E_ORBIT_IMAGE_SOURCE");
		const long = `data:image/png;base64,${"A".repeat(10_000)}`;
		const host = setup();
		const seen: Error[] = [];
		mount(html`<div><img src=${long} /></div>`, {
			viewport,
			onError: (error) => seen.push(error),
		});
		expect(image(host).node.props.src).toBe("");
		expect(seen[0]?.message.length).toBeLessThan(200);
	});

	describe("an address from data orbit will not load", () => {
		type User = { id: number; name: string; avatar: string };
		const row = (user: () => User) =>
			html`<div><img class="size-8" src=${() => user().avatar} alt="" /><p>${() => user().name}</p></div>`;

		for (const [avatar, code] of [
			["http://cdn.example.org/u/2.png", "E_ORBIT_INSECURE_IMAGE_URL"],
			["data:image/png;base64,iVBORw0KGgo=", "E_ORBIT_IMAGE_SOURCE"],
			["blob:https://app.example/9f6c", "E_ORBIT_IMAGE_SOURCE"],
			["file:///sdcard/a%E0.png", "E_ORBIT_IMAGE_SOURCE"],
			["//cdn.example.org/u/2.png", "E_ORBIT_IMAGE_SOURCE"],
		] as const) {
			it(`first mount: ${avatar.slice(0, 24)} shows nothing for that image, the list is shown`, () => {
				const host = setup();
				const seen: Error[] = [];
				const users: User[] = [
					{ id: 1, name: "Ana", avatar: "https://cdn.example.org/u/1.png" },
					{ id: 2, name: "Bo", avatar },
					{ id: 3, name: "Cy", avatar: "https://cdn.example.org/u/3.png" },
				];
				mount(
					html`<div>${each(
						() => users,
						(u) => u.id,
						row,
					)}</div>`,
					{
						viewport,
						onError: (error) => seen.push(error),
					},
				);
				expect(host.all("RCTText").map(([tag]) => host.text(tag))).toEqual([
					"Ana",
					"Bo",
					"Cy",
				]);
				expect(
					host.all("OrbitImage").map(([, node]) => node.props.src),
				).toEqual([
					"https://cdn.example.org/u/1.png",
					"",
					"https://cdn.example.org/u/3.png",
				]);
				expect(seen.map((error) => Reflect.get(error, "code"))).toEqual([code]);
			});
		}

		it("running app: the list keeps following its data, and a fixed address loads", () => {
			const host = setup();
			const seen: Error[] = [];
			const users = signal<readonly User[]>([
				{ id: 1, name: "Ana", avatar: "https://cdn.example.org/u/1.png" },
			]);
			const root = mount(html`<div>${each(users, (u) => u.id, row)}</div>`, {
				viewport,
				onError: (error) => seen.push(error),
			});
			const names = () => host.all("RCTText").map(([tag]) => host.text(tag));
			users((l) => [
				...l,
				{ id: 2, name: "Bo", avatar: "http://cdn.example.org/u/2.png" },
			]);
			root.flush();
			users((l) => [
				...l,
				{ id: 3, name: "Cy", avatar: "https://cdn.example.org/u/3.png" },
			]);
			root.flush();
			expect(names()).toEqual(["Ana", "Bo", "Cy"]);
			expect(seen).toHaveLength(1);
			expect(seen[0]).toBeInstanceOf(errors.E_ORBIT_INSECURE_IMAGE_URL);
			// The same row, its address fixed: the image loads.
			users((l) =>
				l.map((u) =>
					u.id === 2 ? { ...u, avatar: "https://cdn.example.org/u/2.png" } : u,
				),
			);
			root.flush();
			expect(host.all("OrbitImage").map(([, node]) => node.props.src)).toEqual([
				"https://cdn.example.org/u/1.png",
				"https://cdn.example.org/u/2.png",
				"https://cdn.example.org/u/3.png",
			]);
			// And broken again: reported again, shows nothing.
			users((l) =>
				l.map((u) =>
					u.id === 2 ? { ...u, avatar: "javascript:alert(1)" } : u,
				),
			);
			root.flush();
			expect(host.all("OrbitImage")[1]?.[1].props.src).toBe("");
			expect(seen).toHaveLength(2);
		});

		it("a literal address in the template still throws", () => {
			setup();
			expect(
				errorCode(() =>
					mount(html`<div><img src="http://cdn.example.org/a.png" /></div>`, {
						viewport,
						onError: () => {},
					}),
				),
			).toBe("E_ORBIT_INSECURE_IMAGE_URL");
		});
	});

	it("hands bytes to the host before the commit that shows them", () => {
		const host = setup();
		const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
		mount(html`<div><img src=${bytes} class="size-8" /></div>`, { viewport });
		const { tag, node } = image(host);
		expect(node.props.src).toMatch(/^bytes:\d+$/);
		expect(host.images).toEqual([[tag, bytes]]);
		// Sent while no batch had reached the host yet: before the mount ops.
		expect(host.imagesAt).toEqual([0]);
	});

	it("accepts an ArrayBuffer", () => {
		const host = setup();
		const buffer = new Uint8Array([1, 2, 3]).buffer;
		mount(html`<div><img src=${buffer} /></div>`, { viewport });
		expect([...(host.images[0]?.[1] ?? [])]).toEqual([1, 2, 3]);
	});

	it("follows a reactive src: new bytes are sent again under a new version", async () => {
		const host = setup();
		const first = new Uint8Array([1]);
		const second = new Uint8Array([2]);
		const current = signal<Uint8Array | string>(first);
		mount(html`<div><img src=${() => current()} /></div>`, { viewport });
		const { tag, node } = image(host);
		const before = node.props.src;
		current(second);
		await Promise.resolve();
		expect(node.props.src).not.toBe(before);
		expect(host.images).toEqual([
			[tag, first],
			[tag, second],
		]);
		current("https://cdn.example.com/b.jpg");
		await Promise.resolve();
		expect(node.props.src).toBe("https://cdn.example.com/b.jpg");
		expect(host.images).toHaveLength(2);
	});

	it("sends no bytes for an image the commit never reaches", async () => {
		const host = setup();
		const shown = signal(true);
		const bytes = new Uint8Array([9]);
		mount(
			html`<div>${() => (shown() ? html`<img src=${bytes} />` : "")}</div>`,
			{ viewport },
		);
		expect(host.images).toHaveLength(1);
		shown(false);
		shown(true);
		shown(false);
		await Promise.resolve();
		// The image created by the second `true` was gone before any commit.
		expect(host.images).toHaveLength(1);
	});

	it("fires @click on an image", () => {
		const host = setup();
		let clicks = 0;
		mount(
			html`<div><img src="a.png" class="size-8" @click=${() => clicks++} /></div>`,
			{ viewport },
		);
		const { tag } = image(host);
		host.handler?.(tag, "topPress", 0, 0, '{"x":1,"y":1}');
		expect(clicks).toBe(1);
	});
});
