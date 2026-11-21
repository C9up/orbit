# @c9up/orbit

aurora components as native views on a phone.

A component written with `@c9up/aurora/core` — `html`, `component`, signals,
Tailwind classes — renders unchanged on Android: orbit keeps a tree of native
nodes that aurora's signals patch, and commits it over JSI to a Rust host. The
host lays the tree out (taffy), diffs it against what is on screen and hands
mount operations to the platform's own views. Animations and scroll-driven
values run on the UI thread, driven by the host on every vsync, so a busy JS
thread does not stop them. No React, no Expo.

```ts
import { component, html, signal } from "@c9up/aurora/core";
import { mount, MotionValue, useHost } from "@c9up/orbit";
import { Dimensions, TurboModuleRegistry } from "react-native";

const Counter = component(() => {
  const count = signal(0);
  return html`<div class="flex items-center justify-between p-4 bg-white rounded-lg">
    <span class="text-base text-slate-700">Compteur : ${count}</span>
    <div class="px-4 py-2 bg-blue-600 rounded-md" @click=${() => count((n) => n + 1)}>
      <span class="text-white font-semibold">+1</span>
    </div>
  </div>`;
});

useHost(TurboModuleRegistry.getEnforcing("NativeOrbit"));
mount(Counter({}), { viewport: Dimensions.get("window") });
```

## What maps to what

| Template | Native |
|---|---|
| block elements (`div`, `section`, …) | a view |
| `p`, `h1`–`h6`, `label` | a text |
| inline elements (`span`, `strong`, `em`, …) | a run inside the surrounding text |
| text sitting in a view | wrapped in an anonymous text, as CSS does |
| `class="…"` | the Tailwind subset in `src/tailwind.ts`; text styles cascade |
| a `flex` container | each child its own item; `flex` is a row, as on the web |
| `overflow-y-auto` | a native scroll view around a content view |
| `overflow-hidden` | children clipped to the box (and its rounded corners); otherwise they may overflow, as in CSS |
| `shadow-*` | a CSS box shadow, drawn by the parent outside the box (Android 8+) |
| `backdrop-blur-*` | what is behind the view, blurred (Android 12+; the translucent background alone below) |
| `@click=${fn}` | a press, recognized natively: fires on release if the finger stayed put; a ripple shows at once |
| `@longpress`, `@pan`, `@swipe` | recognized natively too (see Gestures) |
| `motion=${{ opacity, translateX, translateY, scale }}` | UI-thread animation (`MotionValue`) |
| `scroll-y=${value}` | the scroll offset feeds a `MotionValue` |
| `input`, `textarea` | the platform's text field (`EditText`): typing never waits for JS |
| `@input`, `@change`, `@focus`, `@blur`, Enter as `@keydown` | the field's events, `event.target.value` carrying the text |
| `.value=${() => text()}` | sets the field only when the app changes it, never over what is being typed |
| `field-sizing-content` (+ `max-h-*`) | a `textarea` that grows with its lines, up to its maximum |
| `img` | an image view, decoded off the UI thread at the size it is shown |
| `each(items, key, render)` | one row per key: a kept row keeps its views and moves, a new key builds one row, a key that left deletes its row |
| `each(…, { lazy })` | only the rows in the nearest scroll view's viewport, plus a margin, exist (see below) |

Both read `placeholder`, `maxlength`, `autocomplete`, `inputmode` and
`disabled`; `input` reads `type` for the keyboard and for a password field,
`textarea` reads `rows`. The root lays out inside the safe area: the status bar, the navigation
buttons, a display cutout and the open keyboard are kept clear of content.

An `img` reads `src` and `alt`, and is sized by its classes (`w-*`, `h-*`,
`size-*`, `aspect-square`, `aspect-video`): its box never waits for the image
to learn a size, so an unsized image takes no height. `object-cover`,
`object-contain`, `object-none` and `object-scale-down` fit it (`fill` by
default, as in CSS), `rounded-*` clips it and a border is drawn over it.
`src` is

- an `https://` URL (plain `http:` throws `E_ORBIT_INSECURE_IMAGE_URL`);
- a path (`/data/…` or `file://…`), or a `content://` URI from a picker;
- a bare name, read from the app's bundled assets;
- bytes, a `Uint8Array` or an `ArrayBuffer` (`src=${bytes}`): sent to the
  native side's memory at the next commit, never written to disk, and zeroed
  with the node, so a decrypted media stays out of storage. orbit reads the
  array when it commits: keep it unchanged until the image shows.

Any other scheme (`data:`, `javascript:`…) throws `E_ORBIT_IMAGE_SOURCE`.
Images are decoded at the size their box is laid out to, never above the
source's own size nor 4096 px a side, and kept decoded in a memory cache
bounded to an eighth of the app's heap; a download or a file over 64 MB is
refused. Remote images have no disk cache yet.

Not mapped yet (`E_ORBIT_UNSUPPORTED_ELEMENT`): `select`, `svg`, `canvas`. Line height and accessibility are still to come; the Tailwind subset is hand-written until it
is compiled from nebula's theme.

## Long lists

`each(items, key, render, { lazy: { estimate, overscan, from } })` builds only
the rows intersecting its scroll view's viewport, plus `overscan` dp on each
side, between two spacer views that stand for the others at their measured
heights (`estimate` for a row not shown yet). It picks its rows with aurora's
own window math, so a list behaves as on the web. On each scroll it records
the offset and picks the window once per frame; after each commit it reads
its rows' frames from the host, and when a measure corrects an estimate
above the viewport it scrolls the native view by the difference, so what is
on screen stays put. `from: 'end'` starts at the bottom and follows new rows
while the reader is there: a conversation.

On the maintainer's phone, a conversation of 10 000 messages of varying
length mounts in about 70 ms (30 messages: about 40 ms, the same rows built)
and scrolls without a dropped frame.

## Gestures

orbit-host recognizes gestures on the UI thread (`crates/orbit-host/src/gesture.rs`),
the way react-native-gesture-handler does for React Native: every touch goes
to Rust before any view, so the press feedback starts even while the JS
thread is busy, and JS receives the outcome when it can.

- `@click`: fires on release if the finger stayed within 10 dp and nothing
  took the touch over. A ripple, masked by the view's rounded box, starts
  where the finger is — at once, or after 100 ms inside a scroll view so a
  scroll that starts on a row does not flash it.
- `@longpress`: after 500 ms held; the release then fires no click.
- `@pan`: once the finger moves past the slop, `{ phase, dx, dy, vx, vy }`
  (dp, dp/s) on `start`, each `move`, and `end` or `cancel`.
- `@swipe`: a pan that ended at 500 dp/s or more, `{ direction, vx, vy }`.

Inside a scroll view a drag along its axis is the scroll view's; across it,
a pan or a swipe claims the touch and the scroll view gets a cancel. A
swipe started on a pressable row of a list scrolls it without selecting.

## Shadows and glass

A shadow is drawn the way browsers draw one: a blurred rounded rectangle
rendered once into a small alpha bitmap per radius and blur, then drawn as
nine slices around the box, so a list of shadowed cards costs bitmap draws,
not a blur per card per frame. It is painted outside the box only, so a
translucent view does not show its own shadow.

`backdrop-blur-*` blurs what the view's parent drew before it — its
background and earlier siblings, such as the list scrolling under a glass
header — recorded at a quarter of the size into a render node blurred by
`RenderEffect`. Content that is not an earlier sibling (an ancestor's
siblings) is not part of the backdrop.

Measured on the maintainer's phone (Adreno 610, 90 Hz) on the glass demo
while scrolling, against the same screen without effects: 15.5 ms per frame
against 13.0 (RenderThread 3.6 against 1.1 ms, GPU 9.5 against 10.1 ms) when
the RenderThread runs on a fast core; that screen does not hold 90 Hz
without effects either.

## Pieces

- `src/` — the JS side: the native node tree, the template mapping, the commit
  protocol, motion values, colours. It imports nothing from React Native and is
  tested in Node against a fake host (`tests/unit`).
- `crates/orbit-host` — the Rust host behind a C ABI: tree, taffy layout (React
  Native's defaults: column, no shrink), text measured by the platform, diff
  into mount operations, UI-thread motion.
- `android/` — the platform layer (Kotlin views whose frames come from Rust,
  touch forwarding, the vsync tick) and the JSI module (`NativeOrbit.cpp`).
- `specs/NativeOrbit.ts` — the TurboModule spec React Native's codegen reads.

Until `ream` builds mobile apps, an app wires orbit by hand: run
`bash node_modules/@c9up/orbit/scripts/build-android.sh` (npm does not keep
the executable bit), include `android/orbit.cmake` in its native build,
register `NativeOrbit` in its module provider, and add the spec and the Kotlin
sources to the app module. iOS is not there yet.

## Requirements

`@c9up/aurora` 0.1.53 or later (its host-free `./core` and `./renderer`
entries), React Native 0.87 with the new architecture, Hermes.
