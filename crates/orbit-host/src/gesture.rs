//! Press, long press, pan and swipe, recognized on the UI thread.
//!
//! The platform hands every touch to `touch` as it arrives, and calls `tick`
//! on every vsync; nothing waits for JS. What comes back is a list of
//! commands: the press feedback to show now (a ripple, on the UI thread), the
//! gesture a view claimed (the platform then stops feeding the scroll view
//! under it), and the events to deliver to JS when it can take them.
//!
//! The commit (JS thread) keeps the tree this needs: each mounted node's
//! parent, the gestures its handlers asked for, and whether it scrolls.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Gesture flags a node's handlers ask for (its `gestures` prop).
pub const PRESS: u8 = 1;
pub const LONG_PRESS: u8 = 2;
pub const PAN: u8 = 4;
pub const SWIPE: u8 = 8;

/// Touch actions from the platform.
pub const DOWN: u8 = 0;
pub const MOVE: u8 = 1;
pub const UP: u8 = 2;
pub const CANCEL: u8 = 3;

/// Show or hide the press feedback: i32 tag, u8 on, f32 x, f32 y (the touch, dp, root).
pub const CMD_PRESSED: u8 = 1;
/// A view claimed the gesture: i32 tag. The scroll view under it stops.
pub const CMD_CLAIM: u8 = 2;
/// An event for JS: i32 tag, then the type and its JSON data, each i32 length + UTF-8.
pub const CMD_EVENT: u8 = 3;

/// How far a finger moves (dp) before a press becomes a drag.
const SLOP: f32 = 10.0;
/// How long a press is held before it is a long press.
const LONG_PRESS_NS: i64 = 500_000_000;
/// Inside a scroll view the feedback waits this long, so a scroll that starts
/// on a row does not flash it (Android's tap timeout).
const FEEDBACK_DELAY_NS: i64 = 100_000_000;
/// The speed (dp/s) a pan must end with to be a swipe.
const SWIPE_SPEED: f32 = 500.0;
/// The span of recent moves the release velocity is taken over.
const VELOCITY_WINDOW_NS: i64 = 100_000_000;

struct NodeInfo {
    parent: i32,
    flags: u8,
    scroll: bool,
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum State {
    /// Down, not moved past the slop: a press or a long press to be.
    Pending,
    /// Held long enough: the long press fired, the release does nothing more.
    LongPressed,
    /// Moved past the slop and claimed by a pan or a swipe.
    Panning,
}

struct Active {
    owner: i32,
    flags: u8,
    in_scroll: bool,
    start: (f32, f32, i64),
    samples: VecDeque<(i64, f32, f32)>,
    state: State,
    feedback_shown: bool,
}

#[derive(Default)]
pub struct Gestures {
    nodes: HashMap<i32, NodeInfo>,
    active: Option<Active>,
}

pub static GESTURES: Mutex<Option<Gestures>> = Mutex::new(None);

pub fn with<R>(f: impl FnOnce(&mut Gestures) -> R) -> R {
    let mut guard = GESTURES.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(Gestures::default))
}

fn put_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_str(out: &mut Vec<u8>, s: &str) {
    put_i32(out, s.len() as i32);
    out.extend_from_slice(s.as_bytes());
}

fn feedback(out: &mut Vec<u8>, tag: i32, on: bool, x: f32, y: f32) {
    out.push(CMD_PRESSED);
    put_i32(out, tag);
    out.push(u8::from(on));
    put_f32(out, x);
    put_f32(out, y);
}

fn event(out: &mut Vec<u8>, tag: i32, kind: &str, data: &serde_json::Value) {
    out.push(CMD_EVENT);
    put_i32(out, tag);
    put_str(out, kind);
    put_str(out, &data.to_string());
}

impl Gestures {
    // ---- the tree, kept by the commit

    pub fn set_node(&mut self, tag: i32, flags: u8, scroll: bool) {
        let entry = self.nodes.entry(tag).or_insert(NodeInfo {
            parent: 0,
            flags: 0,
            scroll: false,
        });
        entry.flags = flags;
        entry.scroll = scroll;
    }

    pub fn set_parent(&mut self, tag: i32, parent: i32) {
        if let Some(node) = self.nodes.get_mut(&tag) {
            node.parent = parent;
        }
    }

    pub fn remove(&mut self, tag: i32) {
        self.nodes.remove(&tag);
        if self.active.as_ref().map(|a| a.owner) == Some(tag) {
            self.active = None;
        }
    }

    /// The nearest node at or above `hit` that asked for a gesture, its flags,
    /// and whether a scroll view holds it.
    fn owner_of(&self, hit: i32) -> Option<(i32, u8, bool)> {
        let mut owner: Option<(i32, u8)> = None;
        let mut in_scroll = false;
        let mut tag = hit;
        // The depth bound stops a cycle a bad tree would make.
        for _ in 0..10_000 {
            let Some(info) = self.nodes.get(&tag) else {
                break;
            };
            if owner.is_none() && info.flags != 0 {
                owner = Some((tag, info.flags));
            } else if owner.is_some() && info.scroll {
                in_scroll = true;
                break;
            }
            if info.parent == 0 {
                break;
            }
            tag = info.parent;
        }
        owner.map(|(tag, flags)| (tag, flags, in_scroll))
    }

    // ---- recognition

    /// A touch (dp, the root's coordinates). `hit` is the deepest view under a
    /// DOWN; ignored otherwise.
    pub fn touch(&mut self, action: u8, x: f32, y: f32, now: i64, hit: i32, out: &mut Vec<u8>) {
        match action {
            DOWN => {
                self.end(out, x, y);
                let Some((owner, flags, in_scroll)) = self.owner_of(hit) else {
                    return;
                };
                let mut active = Active {
                    owner,
                    flags,
                    in_scroll,
                    start: (x, y, now),
                    samples: VecDeque::from([(now, x, y)]),
                    state: State::Pending,
                    feedback_shown: false,
                };
                if flags & (PRESS | LONG_PRESS) != 0 && !in_scroll {
                    feedback(out, owner, true, x, y);
                    active.feedback_shown = true;
                }
                self.active = Some(active);
            }
            MOVE => self.moved(x, y, now, out),
            UP => self.released(x, y, now, out),
            _ => self.end(out, x, y),
        }
    }

    /// Every vsync: a long press held long enough, a delayed feedback due.
    pub fn tick(&mut self, now: i64, out: &mut Vec<u8>) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        if active.state != State::Pending {
            return;
        }
        let (x, y, start) = active.start;
        let feedback_wanted = active.flags & (PRESS | LONG_PRESS) != 0;
        if feedback_wanted && !active.feedback_shown && now - start >= FEEDBACK_DELAY_NS {
            feedback(out, active.owner, true, x, y);
            active.feedback_shown = true;
        }
        if active.flags & LONG_PRESS != 0 && now - start >= LONG_PRESS_NS {
            active.state = State::LongPressed;
            event(
                out,
                active.owner,
                "topLongPress",
                &serde_json::json!({ "x": x, "y": y }),
            );
        }
    }

    fn moved(&mut self, x: f32, y: f32, now: i64, out: &mut Vec<u8>) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        active.samples.push_back((now, x, y));
        while active.samples.len() > 2
            && active
                .samples
                .front()
                .is_some_and(|(t, _, _)| now - t > VELOCITY_WINDOW_NS)
        {
            active.samples.pop_front();
        }
        let (sx, sy, _) = active.start;
        let (dx, dy) = (x - sx, y - sy);
        let owner = active.owner;
        let pans = active.flags & PAN != 0;
        match active.state {
            State::Pending if dx.hypot(dy) > SLOP => {
                // Along a scroll view's axis, the scroll view wins; across
                // it, or outside one, a pan or a swipe claims the gesture.
                let wants_pan = active.flags & (PAN | SWIPE) != 0;
                if !(wants_pan && (!active.in_scroll || dx.abs() > dy.abs())) {
                    self.end(out, x, y);
                    return;
                }
                if active.feedback_shown {
                    feedback(out, owner, false, x, y);
                    active.feedback_shown = false;
                }
                active.state = State::Panning;
                out.push(CMD_CLAIM);
                put_i32(out, owner);
                if pans {
                    event(out, owner, "topPan", &pan_data("start", dx, dy, 0.0, 0.0));
                }
            }
            State::Panning if pans => {
                let (vx, vy) = velocity(&active.samples);
                event(out, owner, "topPan", &pan_data("move", dx, dy, vx, vy));
            }
            _ => {}
        }
    }

    fn released(&mut self, x: f32, y: f32, now: i64, out: &mut Vec<u8>) {
        let Some(mut active) = self.active.take() else {
            return;
        };
        active.samples.push_back((now, x, y));
        let (sx, sy, _) = active.start;
        let (dx, dy) = (x - sx, y - sy);
        match active.state {
            State::Pending => {
                // A tap shorter than the feedback delay still flashes it.
                if !active.feedback_shown && active.flags & (PRESS | LONG_PRESS) != 0 {
                    feedback(out, active.owner, true, sx, sy);
                }
                feedback(out, active.owner, false, x, y);
                if active.flags & PRESS != 0 {
                    event(
                        out,
                        active.owner,
                        "topPress",
                        &serde_json::json!({ "x": x, "y": y }),
                    );
                }
            }
            State::LongPressed => feedback(out, active.owner, false, x, y),
            State::Panning => {
                let (vx, vy) = velocity(&active.samples);
                if active.flags & PAN != 0 {
                    event(
                        out,
                        active.owner,
                        "topPan",
                        &pan_data("end", dx, dy, vx, vy),
                    );
                }
                if active.flags & SWIPE != 0 {
                    let horizontal = vx.abs() >= vy.abs();
                    let speed = if horizontal { vx.abs() } else { vy.abs() };
                    if speed >= SWIPE_SPEED {
                        let direction = match (horizontal, vx > 0.0, vy > 0.0) {
                            (true, true, _) => "right",
                            (true, false, _) => "left",
                            (false, _, true) => "down",
                            (false, _, false) => "up",
                        };
                        event(
                            out,
                            active.owner,
                            "topSwipe",
                            &serde_json::json!({ "direction": direction, "vx": vx, "vy": vy }),
                        );
                    }
                }
            }
        }
    }

    /// Drop the gesture in progress: its feedback goes, a pan is cancelled.
    fn end(&mut self, out: &mut Vec<u8>, x: f32, y: f32) {
        let Some(active) = self.active.take() else {
            return;
        };
        if active.feedback_shown {
            feedback(out, active.owner, false, x, y);
        }
        if active.state == State::Panning && active.flags & PAN != 0 {
            let (sx, sy, _) = active.start;
            event(
                out,
                active.owner,
                "topPan",
                &pan_data("cancel", x - sx, y - sy, 0.0, 0.0),
            );
        }
    }
}

fn pan_data(phase: &str, dx: f32, dy: f32, vx: f32, vy: f32) -> serde_json::Value {
    serde_json::json!({ "phase": phase, "dx": dx, "dy": dy, "vx": vx, "vy": vy })
}

/// dp per second over the recent moves.
fn velocity(samples: &VecDeque<(i64, f32, f32)>) -> (f32, f32) {
    let (Some(first), Some(last)) = (samples.front(), samples.back()) else {
        return (0.0, 0.0);
    };
    let dt = (last.0 - first.0) as f32 / 1e9;
    if dt <= 0.0 {
        return (0.0, 0.0);
    }
    ((last.1 - first.1) / dt, (last.2 - first.2) / dt)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: i64 = 1_000_000;

    /// Commands decoded: ("pressed", tag, on) / ("claim", tag) / (type, tag, data).
    fn decode(buf: &[u8]) -> Vec<(String, i32, String)> {
        let i32_at = |i: usize| i32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
        let mut out = Vec::new();
        let mut i = 0;
        while i < buf.len() {
            let tag = i32_at(i + 1);
            match buf[i] {
                CMD_PRESSED => {
                    out.push(("pressed".into(), tag, (buf[i + 5] == 1).to_string()));
                    i += 1 + 4 + 1 + 8;
                }
                CMD_CLAIM => {
                    out.push(("claim".into(), tag, String::new()));
                    i += 5;
                }
                CMD_EVENT => {
                    let mut at = i + 5;
                    let len = i32_at(at) as usize;
                    let kind = String::from_utf8(buf[at + 4..at + 4 + len].to_vec()).unwrap();
                    at += 4 + len;
                    let len = i32_at(at) as usize;
                    let data = String::from_utf8(buf[at + 4..at + 4 + len].to_vec()).unwrap();
                    out.push((kind, tag, data));
                    i = at + 4 + len;
                }
                c => panic!("unknown command {c}"),
            }
        }
        out
    }

    /// A row (5) with `flags` holding a text (7), in a column (3), maybe in a scroll view (1).
    fn tree(flags: u8, scroll: bool) -> Gestures {
        let mut g = Gestures::default();
        g.set_node(1, 0, scroll);
        g.set_node(3, 0, false);
        g.set_node(5, flags, false);
        g.set_node(7, 0, false);
        g.set_parent(3, 1);
        g.set_parent(5, 3);
        g.set_parent(7, 5);
        g
    }

    fn run(g: &mut Gestures, steps: &[(u8, f32, f32, i64)]) -> Vec<(String, i32, String)> {
        let mut out = Vec::new();
        for &(action, x, y, t) in steps {
            if action == 9 {
                g.tick(t * MS, &mut out);
            } else {
                g.touch(action, x, y, t * MS, 7, &mut out);
            }
        }
        decode(&out)
    }

    const TICK: u8 = 9;

    fn kinds(cmds: &[(String, i32, String)]) -> Vec<&str> {
        cmds.iter().map(|(k, _, _)| k.as_str()).collect()
    }

    #[test]
    fn a_tap_on_a_text_presses_its_pressable_row_with_feedback_at_once() {
        let mut g = tree(PRESS, false);
        let cmds = run(&mut g, &[(DOWN, 10.0, 10.0, 0), (UP, 12.0, 11.0, 80)]);
        assert_eq!(kinds(&cmds), vec!["pressed", "pressed", "topPress"]);
        assert!(cmds.iter().all(|(_, tag, _)| *tag == 5));
        assert_eq!(cmds[0].2, "true");
        assert_eq!(cmds[1].2, "false");
    }

    #[test]
    fn moving_past_the_slop_cancels_a_press() {
        let mut g = tree(PRESS, false);
        let cmds = run(
            &mut g,
            &[
                (DOWN, 10.0, 10.0, 0),
                (MOVE, 10.0, 30.0, 16),
                (UP, 10.0, 30.0, 32),
            ],
        );
        assert_eq!(kinds(&cmds), vec!["pressed", "pressed"]);
    }

    #[test]
    fn in_a_scroll_view_the_feedback_waits_and_a_scroll_never_flashes_it() {
        let mut g = tree(PRESS, true);
        // A scroll starting on the row: no feedback at all, no press.
        let scrolled = run(
            &mut g,
            &[
                (DOWN, 10.0, 10.0, 0),
                (TICK, 0.0, 0.0, 16),
                (MOVE, 10.0, 40.0, 32),
                (UP, 10.0, 90.0, 60),
            ],
        );
        assert!(scrolled.is_empty(), "{scrolled:?}");
        // Held still: the feedback comes after the delay, the press on release.
        let held = run(
            &mut g,
            &[
                (DOWN, 10.0, 10.0, 0),
                (TICK, 0.0, 0.0, 50),
                (TICK, 0.0, 0.0, 110),
                (UP, 10.0, 10.0, 200),
            ],
        );
        assert_eq!(kinds(&held), vec!["pressed", "pressed", "topPress"]);
        // A quick tap still flashes it.
        let quick = run(&mut g, &[(DOWN, 10.0, 10.0, 0), (UP, 10.0, 10.0, 40)]);
        assert_eq!(kinds(&quick), vec!["pressed", "pressed", "topPress"]);
    }

    #[test]
    fn a_long_press_fires_from_the_tick_and_replaces_the_press() {
        let mut g = tree(PRESS | LONG_PRESS, false);
        let cmds = run(
            &mut g,
            &[
                (DOWN, 10.0, 10.0, 0),
                (TICK, 0.0, 0.0, 300),
                (TICK, 0.0, 0.0, 510),
                (UP, 10.0, 10.0, 700),
            ],
        );
        assert_eq!(kinds(&cmds), vec!["pressed", "topLongPress", "pressed"]);
    }

    #[test]
    fn a_horizontal_pan_in_a_scroll_view_claims_and_ends_as_a_swipe() {
        let mut g = tree(PRESS | PAN | SWIPE, true);
        let cmds = run(
            &mut g,
            &[
                (DOWN, 100.0, 10.0, 0),
                (MOVE, 80.0, 12.0, 16),
                (MOVE, 40.0, 14.0, 32),
                (UP, 0.0, 15.0, 48),
            ],
        );
        assert_eq!(
            kinds(&cmds),
            vec!["claim", "topPan", "topPan", "topPan", "topSwipe"]
        );
        assert!(cmds[1].2.contains(r#""phase":"start""#));
        assert!(cmds[3].2.contains(r#""phase":"end""#));
        assert!(cmds[4].2.contains(r#""direction":"left""#), "{}", cmds[4].2);
        assert!(!kinds(&cmds).contains(&"topPress"));
    }

    #[test]
    fn a_vertical_drag_on_a_pannable_row_is_left_to_its_scroll_view() {
        let mut g = tree(PRESS | SWIPE, true);
        let cmds = run(
            &mut g,
            &[
                (DOWN, 10.0, 10.0, 0),
                (MOVE, 12.0, 40.0, 16),
                (UP, 12.0, 120.0, 40),
            ],
        );
        assert!(cmds.is_empty(), "{cmds:?}");
    }

    #[test]
    fn a_slow_pan_is_no_swipe_and_a_cancel_ends_the_pan() {
        let mut g = tree(PAN | SWIPE, false);
        let slow = run(
            &mut g,
            &[
                (DOWN, 0.0, 0.0, 0),
                (MOVE, 20.0, 0.0, 200),
                (MOVE, 40.0, 0.0, 400),
                (UP, 41.0, 0.0, 600),
            ],
        );
        assert_eq!(kinds(&slow), vec!["claim", "topPan", "topPan", "topPan"]);
        let cancelled = run(
            &mut g,
            &[
                (DOWN, 0.0, 0.0, 0),
                (MOVE, 30.0, 0.0, 16),
                (CANCEL, 30.0, 0.0, 32),
            ],
        );
        assert_eq!(kinds(&cancelled), vec!["claim", "topPan", "topPan"]);
        assert!(cancelled[2].2.contains(r#""phase":"cancel""#));
    }

    #[test]
    fn a_touch_outside_any_pressable_does_nothing() {
        let mut g = tree(0, false);
        let cmds = run(&mut g, &[(DOWN, 1.0, 1.0, 0), (UP, 1.0, 1.0, 10)]);
        assert!(cmds.is_empty());
    }
}
