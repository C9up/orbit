//! UI-thread animation for the Rust host.
//!
//! JS declares values, interpolations, animations and bindings once; the
//! platform calls `tick` on every vsync from the UI thread, with the current
//! scroll offsets, and applies what comes back. Nothing here waits for JS, so a
//! blocked JS thread does not stop an animation or a scroll-driven value.

use std::collections::HashMap;
use std::sync::Mutex;

pub const PROP_OPACITY: u8 = 0;
pub const PROP_TRANSLATE_X: u8 = 1;
pub const PROP_TRANSLATE_Y: u8 = 2;
pub const PROP_SCALE: u8 = 3;
/// Shown above 0.5, hidden (laid out, untouchable, not drawn) at or below:
/// what hides a covered screen the frame its cover finishes arriving.
pub const PROP_VISIBLE: u8 = 4;

enum Node {
    Value(f64),
    Interpolation {
        input: i32,
        from: Vec<f64>,
        to: Vec<f64>,
    },
}

enum Anim {
    Frames {
        frames: Vec<f64>,
        from: f64,
        to: f64,
        start_ns: Option<i64>,
        looping: bool,
    },
    Spring {
        to: f64,
        stiffness: f64,
        damping: f64,
        mass: f64,
        velocity: f64,
        last_ns: Option<i64>,
    },
}

#[derive(Default)]
pub struct Motion {
    nodes: HashMap<i32, Node>,
    anims: HashMap<i32, Anim>,
    bindings: Vec<(i32, u8, i32)>,
    scroll: HashMap<i32, i32>,
    last: HashMap<(i32, u8), f32>,
}

pub static MOTION: Mutex<Option<Motion>> = Mutex::new(None);

pub fn with<R>(f: impl FnOnce(&mut Motion) -> R) -> R {
    let mut guard = MOTION.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(Motion::default))
}

const FRAME_NS: f64 = 1e9 / 60.0;

impl Motion {
    pub fn value(&mut self, tag: i32, initial: f64) {
        self.nodes.insert(tag, Node::Value(initial));
    }

    pub fn interpolation(&mut self, tag: i32, input: i32, from: Vec<f64>, to: Vec<f64>) {
        self.nodes
            .insert(tag, Node::Interpolation { input, from, to });
    }

    pub fn set(&mut self, tag: i32, v: f64) {
        self.anims.remove(&tag);
        self.nodes.insert(tag, Node::Value(v));
    }

    pub fn stop(&mut self, tag: i32) {
        self.anims.remove(&tag);
    }

    pub fn frames(&mut self, tag: i32, frames: Vec<f64>, to: f64, looping: bool) {
        let from = self.read(tag);
        self.anims.insert(
            tag,
            Anim::Frames {
                frames,
                from,
                to,
                start_ns: None,
                looping,
            },
        );
    }

    pub fn spring(&mut self, tag: i32, to: f64, stiffness: f64, damping: f64, mass: f64) {
        self.anims.insert(
            tag,
            Anim::Spring {
                to,
                stiffness,
                damping,
                mass: mass.max(1e-3),
                velocity: 0.0,
                last_ns: None,
            },
        );
    }

    /// Forget a value or an interpolation, its animation and what it drives.
    pub fn dispose(&mut self, tag: i32) {
        self.nodes.remove(&tag);
        self.anims.remove(&tag);
        self.bindings.retain(|(_, _, node)| *node != tag);
        self.scroll.retain(|_, value| *value != tag);
    }

    /// A view the host deleted: nothing drives it any more.
    pub fn forget_view(&mut self, view: i32) {
        self.bindings.retain(|(v, _, _)| *v != view);
        self.last.retain(|(v, _), _| *v != view);
        self.scroll.remove(&view);
    }

    pub fn bind(&mut self, view: i32, prop: u8, node: i32) {
        self.bindings
            .retain(|(v, p, _)| !(*v == view && *p == prop));
        self.bindings.push((view, prop, node));
    }

    pub fn bind_scroll(&mut self, scroll_view: i32, value: i32) {
        self.scroll.insert(scroll_view, value);
    }

    fn read(&self, tag: i32) -> f64 {
        match self.nodes.get(&tag) {
            Some(Node::Value(v)) => *v,
            Some(Node::Interpolation { input, from, to }) => {
                interpolate(self.read(*input), from, to)
            }
            None => 0.0,
        }
    }

    /// Advance to `now_ns`; returns (view, prop, value) records for what changed.
    pub fn tick(&mut self, now_ns: i64, scrolls: &[(i32, f32)], out: &mut Vec<u8>) -> bool {
        for (view, y) in scrolls {
            if let Some(value) = self.scroll.get(view) {
                self.nodes.insert(*value, Node::Value(f64::from(*y)));
            }
        }
        let mut finished = Vec::new();
        for (tag, anim) in self.anims.iter_mut() {
            let next = match anim {
                Anim::Frames {
                    frames,
                    from,
                    to,
                    start_ns,
                    looping,
                } => {
                    let start = *start_ns.get_or_insert(now_ns);
                    let mut index = ((now_ns - start) as f64 / FRAME_NS) as usize;
                    if index >= frames.len() {
                        if *looping && !frames.is_empty() {
                            index %= frames.len();
                        } else {
                            finished.push(*tag);
                            index = frames.len().saturating_sub(1);
                        }
                    }
                    let f = frames.get(index).copied().unwrap_or(1.0);
                    *from + f * (*to - *from)
                }
                Anim::Spring {
                    to,
                    stiffness,
                    damping,
                    mass,
                    velocity,
                    last_ns,
                } => {
                    let x = match self.nodes.get(tag) {
                        Some(Node::Value(v)) => *v,
                        _ => 0.0,
                    };
                    let dt = last_ns
                        .map(|l| ((now_ns - l) as f64 / 1e9).clamp(0.0, 0.064))
                        .unwrap_or(0.0);
                    *last_ns = Some(now_ns);
                    // Semi-implicit Euler in 1 ms steps: stable for stiff springs.
                    let (mut x, mut v) = (x, *velocity);
                    let steps = (dt * 1000.0).ceil() as usize;
                    let h = if steps > 0 { dt / steps as f64 } else { 0.0 };
                    for _ in 0..steps {
                        let a = (-*stiffness * (x - *to) - *damping * v) / *mass;
                        v += a * h;
                        x += v * h;
                    }
                    *velocity = v;
                    if v.abs() < 1e-3 && (x - *to).abs() < 1e-3 {
                        finished.push(*tag);
                        x = *to;
                    }
                    x
                }
            };
            self.nodes.insert(*tag, Node::Value(next));
        }
        for tag in finished {
            self.anims.remove(&tag);
        }
        for &(view, prop, node) in &self.bindings {
            let v = self.read(node) as f32;
            if self.last.get(&(view, prop)) != Some(&v) {
                self.last.insert((view, prop), v);
                out.extend_from_slice(&view.to_le_bytes());
                out.push(prop);
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        !self.anims.is_empty()
    }
}

fn interpolate(x: f64, from: &[f64], to: &[f64]) -> f64 {
    if from.len() < 2 || to.len() != from.len() {
        return to.first().copied().unwrap_or(x);
    }
    if x <= from[0] {
        return to[0];
    }
    for i in 1..from.len() {
        if x <= from[i] {
            let t = (x - from[i - 1]) / (from[i] - from[i - 1]);
            return to[i - 1] + t * (to[i] - to[i - 1]);
        }
    }
    to[to.len() - 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(buf: &[u8]) -> Vec<(i32, u8, f32)> {
        buf.chunks(9)
            .map(|c| {
                (
                    i32::from_le_bytes([c[0], c[1], c[2], c[3]]),
                    c[4],
                    f32::from_le_bytes([c[5], c[6], c[7], c[8]]),
                )
            })
            .collect()
    }

    #[test]
    fn frames_loop_and_scroll_drive_bindings_without_js() {
        let mut m = Motion::default();
        m.value(1, 0.0);
        m.frames(1, vec![0.0, 0.5, 1.0], 300.0, true);
        m.bind(10, PROP_TRANSLATE_X, 1);
        m.value(2, 0.0);
        m.interpolation(3, 2, vec![0.0, 200.0], vec![1.0, 0.2]);
        m.bind(11, PROP_OPACITY, 3);
        m.bind_scroll(20, 2);
        let frame = FRAME_NS as i64;
        let mut out = Vec::new();
        m.tick(0, &[(20, 0.0)], &mut out);
        out.clear();
        m.tick(frame + 1, &[(20, 100.0)], &mut out);
        let r = records(&out);
        assert!(r.contains(&(10, PROP_TRANSLATE_X, 150.0)), "{r:?}");
        assert!(
            r.iter()
                .any(|&(v, p, x)| v == 11 && p == PROP_OPACITY && (x - 0.6).abs() < 1e-4),
            "{r:?}"
        );
        out.clear();
        // Past the end, a looping animation starts over.
        // 3.5 frames in: index 3 of a 3-frame loop is frame 0 again.
        m.tick(3 * frame + frame / 2, &[(20, 100.0)], &mut out);
        assert_eq!(records(&out), vec![(10, PROP_TRANSLATE_X, 0.0)]);
    }

    #[test]
    fn a_disposed_value_and_a_deleted_view_leave_nothing_behind() {
        let mut m = Motion::default();
        m.value(1, 0.0);
        m.frames(1, vec![0.0, 1.0], 100.0, true);
        m.bind(10, PROP_TRANSLATE_X, 1);
        m.value(2, 1.0);
        m.bind(11, PROP_VISIBLE, 2);
        m.bind_scroll(20, 2);
        let mut out = Vec::new();
        m.tick(0, &[], &mut out);
        m.forget_view(11);
        m.forget_view(20);
        m.dispose(1);
        assert!(m.bindings.is_empty() && m.scroll.is_empty() && m.anims.is_empty());
        assert!(!m.last.contains_key(&(11, PROP_VISIBLE)));
        assert!(!m.nodes.contains_key(&1));
        out.clear();
        assert!(!m.tick(FRAME_NS as i64, &[(20, 5.0)], &mut out));
        assert!(out.is_empty());
    }

    #[test]
    fn a_spring_settles_on_its_target() {
        let mut m = Motion::default();
        m.value(1, 0.8);
        m.spring(1, 1.0, 260.0, 7.0, 1.0);
        let mut t = 0;
        let mut active = true;
        for _ in 0..600 {
            let mut out = Vec::new();
            active = m.tick(t, &[], &mut out);
            t += FRAME_NS as i64;
            if !active {
                break;
            }
        }
        assert!(!active);
        assert!((m.read(1) - 1.0).abs() < 1e-9);
    }
}
