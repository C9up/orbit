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
| `@click=${fn}` | a press: fires on release if the finger stayed put |
| `motion=${{ opacity, translateX, translateY, scale }}` | UI-thread animation (`MotionValue`) |
| `scroll-y=${value}` | the scroll offset feeds a `MotionValue` |

Not mapped yet (`E_ORBIT_UNSUPPORTED_ELEMENT`): `input`, `textarea`, `select`,
`img`, `svg`, `canvas`. Keyed lists, press feedback, line height and
accessibility are still to come; the Tailwind subset is hand-written until it
is compiled from nebula's theme.

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

`@c9up/aurora` 0.1.52 or later (its host-free `./core` and `./renderer`
entries), React Native 0.87 with the new architecture, Hermes.
