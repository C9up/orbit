import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/** orbit's Rust native host (orbit-host), over JSI. Mirrors `OrbitHost` in src/host.ts. */
export interface Spec extends TurboModule {
  /** The root's size in dp. */
  readonly setViewport: (width: number, height: number) => void;
  /** Commit a JSON batch of tree ops; returns the host's JSON report. */
  readonly commit: (ops: string) => string;
  /** An image node's bytes (a Uint8Array or ArrayBuffer), held in memory until the node goes. */
  readonly imageBytes: (tag: number, bytes: Object) => void;
  /** Where nodes were laid out: a JSON array of tags in, of [x, y, w, h] (dp) or null out. */
  readonly layout: (tags: string) => string;
  /** Scroll a scroll view by `by` dp, or to its end. */
  readonly scroll: (tag: number, by: number, toEnd: boolean) => void;
  /** Touches on host views, as React Native's touch event types, in dp. */
  /** Touches (dp), text-field events with their text in `data`, `topViewport` on tag 0 (window resized). */
  readonly setEventHandler: (handler: (tag: number, type: string, x: number, y: number, data: string) => void) => void;

  // UI-thread animation, driven by orbit-host on every vsync (no JS per frame).
  readonly motionValue: (tag: number, initial: number) => void;
  readonly motionInterpolate: (tag: number, input: number, from: ReadonlyArray<number>, to: ReadonlyArray<number>) => void;
  readonly motionSet: (tag: number, value: number) => void;
  readonly motionStop: (tag: number) => void;
  readonly motionFrames: (tag: number, frames: ReadonlyArray<number>, to: number, loop: boolean) => void;
  readonly motionSpring: (tag: number, to: number, stiffness: number, damping: number, mass: number) => void;
  /** prop: 0 opacity, 1 translateX, 2 translateY, 3 scale. */
  readonly motionBind: (view: number, prop: number, node: number) => void;
  readonly motionBindScroll: (scrollView: number, value: number) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeOrbit');
