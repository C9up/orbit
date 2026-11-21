//! Vector drawings: an `<svg>` subtree, reduced to filled and stroked paths.
//!
//! JS hands over the subtree as it was written — tags, attributes, colours
//! already read into ARGB — and this resolves everything a platform canvas
//! should not have to know: path data (relative commands, smooth curves,
//! arcs), the basic shapes, `g` inheritance, transforms, opacity and
//! `currentColor`. What comes out is a short list of shapes, each a path of
//! move / line / cubic / quad / close in viewBox units with its paint, which
//! the platform view replays scaled to its box.
//!
//! Encoding (little endian), what follows OP_VECTOR's tag and length:
//!
//!   f32 x4   viewBox (min x, min y, width, height)
//!   u8       0 xMidYMid meet, 1 none (stretch)
//!   i32      shape count, then per shape:
//!     i32 fill ARGB (0: none)   u8 fill rule (0 nonzero, 1 evenodd)
//!     i32 stroke ARGB (0: none) f32 stroke width  u8 cap  u8 join  f32 miter
//!     u8 crisp (no antialiasing)
//!     i32 verb count, then per verb: u8 verb, its f32 points
//!       (0 move x y, 1 line x y, 2 cubic x1 y1 x2 y2 x y, 3 quad x1 y1 x y, 4 close)

use serde_json::{Map, Value};

pub const VERB_MOVE: u8 = 0;
pub const VERB_LINE: u8 = 1;
pub const VERB_CUBIC: u8 = 2;
pub const VERB_QUAD: u8 = 3;
pub const VERB_CLOSE: u8 = 4;

/// An affine transform `[a b c d e f]`: x' = a x + c y + e, y' = b x + d y + f.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Matrix([f64; 6]);

impl Matrix {
    const IDENTITY: Matrix = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    /// `self` applied after `inner` (`self × inner`).
    fn then(self, inner: Matrix) -> Matrix {
        let [a, b, c, d, e, f] = self.0;
        let [p, q, r, s, t, u] = inner.0;
        Matrix([
            a * p + c * q,
            b * p + d * q,
            a * r + c * s,
            b * r + d * s,
            a * t + c * u + e,
            b * t + d * u + f,
        ])
    }

    fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }

    /// How much the transform scales a length, on average (for stroke widths).
    fn scale(&self) -> f64 {
        let [a, b, c, d, ..] = self.0;
        (a * d - b * c).abs().sqrt()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PaintValue {
    None,
    Current,
    Color(u32),
}

/// What a `g` hands down to what it holds.
#[derive(Clone, Copy, Debug)]
struct Inherited {
    fill: PaintValue,
    stroke: PaintValue,
    stroke_width: f64,
    cap: u8,
    join: u8,
    miter: f64,
    fill_rule: u8,
    fill_opacity: f64,
    stroke_opacity: f64,
    crisp: bool,
    /// `opacity` is not inherited but multiplies down the groups.
    opacity: f64,
    matrix: Matrix,
}

impl Default for Inherited {
    fn default() -> Self {
        Inherited {
            fill: PaintValue::Color(0xFF00_0000),
            stroke: PaintValue::None,
            stroke_width: 1.0,
            cap: 0,
            join: 0,
            miter: 4.0,
            fill_rule: 0,
            fill_opacity: 1.0,
            stroke_opacity: 1.0,
            crisp: false,
            opacity: 1.0,
            matrix: Matrix::IDENTITY,
        }
    }
}

/// A path being built, in final (transformed) coordinates.
#[derive(Default)]
struct PathOut {
    verbs: Vec<u8>,
    points: Vec<f32>,
}

impl PathOut {
    fn push(&mut self, verb: u8, m: &Matrix, pts: &[(f64, f64)]) {
        self.verbs.push(verb);
        for &(x, y) in pts {
            let (x, y) = m.apply(x, y);
            self.points.push(x as f32);
            self.points.push(y as f32);
        }
    }
}

/// Read an `<svg>` description (`{ color, root }`) into the encoding above.
pub fn encode(vector: &Value) -> Result<Vec<u8>, String> {
    let current = vector
        .get("color")
        .and_then(Value::as_i64)
        .unwrap_or(0xFF00_0000) as u32;
    let root = vector.get("root").ok_or("vector: no root")?;
    let attrs = attrs_of(root);
    let view_box = match attr_str(attrs, "viewBox") {
        Some(text) => {
            let n = numbers(text)?;
            if n.len() != 4 || n[2] <= 0.0 || n[3] <= 0.0 {
                return Err(format!(
                    "svg: viewBox {text:?} is not four numbers with a positive size"
                ));
            }
            [n[0], n[1], n[2], n[3]]
        }
        None => {
            let w = attr_num(attrs, "width").unwrap_or(300.0);
            let h = attr_num(attrs, "height").unwrap_or(150.0);
            [0.0, 0.0, w, h]
        }
    };
    let stretch = attr_str(attrs, "preserveAspectRatio").map(str::trim) == Some("none");
    let mut shapes: Vec<u8> = Vec::new();
    let mut count = 0i32;
    let inherited = inherit(Inherited::default(), attrs)?;
    for child in children_of(root) {
        walk(child, inherited, current, &mut shapes, &mut count)?;
    }
    let mut out = Vec::with_capacity(21 + shapes.len());
    for v in view_box {
        out.extend_from_slice(&(v as f32).to_le_bytes());
    }
    out.push(u8::from(stretch));
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&shapes);
    Ok(out)
}

fn attrs_of(node: &Value) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    node.get("a")
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

fn children_of(node: &Value) -> &[Value] {
    node.get("c")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn attr_str<'a>(attrs: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    attrs.get(key).and_then(Value::as_str)
}

fn attr_num(attrs: &Map<String, Value>, key: &str) -> Option<f64> {
    match attrs.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => length(s),
        _ => None,
    }
}

/// A length attribute: a number, optionally in px.
fn length(text: &str) -> Option<f64> {
    let text = text.trim();
    let text = text.strip_suffix("px").unwrap_or(text);
    text.parse().ok()
}

fn paint(value: &Value) -> Result<PaintValue, String> {
    match value {
        Value::Number(n) => Ok(PaintValue::Color(n.as_i64().unwrap_or(0) as u32)),
        Value::String(s) if s == "none" || s == "transparent" => Ok(PaintValue::None),
        Value::String(s) if s == "currentColor" => Ok(PaintValue::Current),
        other => Err(format!("svg: paint {other} is not a colour")),
    }
}

/// The inherited properties after `attrs` (a `g`, a shape or the svg itself).
fn inherit(mut st: Inherited, attrs: &Map<String, Value>) -> Result<Inherited, String> {
    if let Some(v) = attrs.get("fill") {
        st.fill = paint(v)?;
    }
    if let Some(v) = attrs.get("stroke") {
        st.stroke = paint(v)?;
    }
    if let Some(w) = attr_num(attrs, "stroke-width") {
        st.stroke_width = w.max(0.0);
    }
    if let Some(cap) = attr_str(attrs, "stroke-linecap") {
        st.cap = match cap {
            "round" => 1,
            "square" => 2,
            _ => 0,
        };
    }
    if let Some(join) = attr_str(attrs, "stroke-linejoin") {
        st.join = match join {
            "round" => 1,
            "bevel" => 2,
            _ => 0,
        };
    }
    if let Some(m) = attr_num(attrs, "stroke-miterlimit") {
        st.miter = m.max(1.0);
    }
    if let Some(rule) = attr_str(attrs, "fill-rule") {
        st.fill_rule = u8::from(rule == "evenodd");
    }
    if let Some(o) = attr_num(attrs, "fill-opacity") {
        st.fill_opacity = o.clamp(0.0, 1.0);
    }
    if let Some(o) = attr_num(attrs, "stroke-opacity") {
        st.stroke_opacity = o.clamp(0.0, 1.0);
    }
    if let Some(o) = attr_num(attrs, "opacity") {
        st.opacity *= o.clamp(0.0, 1.0);
    }
    if let Some(r) = attr_str(attrs, "shape-rendering") {
        st.crisp = r == "crispEdges" || r == "optimizeSpeed";
    }
    if let Some(t) = attr_str(attrs, "transform") {
        st.matrix = st.matrix.then(transform(t)?);
    }
    Ok(st)
}

fn walk(
    node: &Value,
    parent: Inherited,
    current: u32,
    out: &mut Vec<u8>,
    count: &mut i32,
) -> Result<(), String> {
    let tag = node.get("t").and_then(Value::as_str).unwrap_or("");
    let attrs = attrs_of(node);
    let st = inherit(parent, attrs)?;
    let mut path = PathOut::default();
    let m = st.matrix;
    let num = |key: &str| attr_num(attrs, key).unwrap_or(0.0);
    match tag {
        "g" => {
            for child in children_of(node) {
                walk(child, st, current, out, count)?;
            }
            return Ok(());
        }
        "path" => {
            if let Some(d) = attr_str(attrs, "d") {
                path_data(d, &m, &mut path)?;
            }
        }
        "rect" => {
            let (x, y, w, h) = (num("x"), num("y"), num("width"), num("height"));
            if w <= 0.0 || h <= 0.0 {
                return Ok(());
            }
            let rx = attr_num(attrs, "rx");
            let ry = attr_num(attrs, "ry");
            let (rx, ry) = match (rx, ry) {
                (Some(a), Some(b)) => (a, b),
                (Some(a), None) | (None, Some(a)) => (a, a),
                (None, None) => (0.0, 0.0),
            };
            rect(
                x,
                y,
                w,
                h,
                rx.clamp(0.0, w / 2.0),
                ry.clamp(0.0, h / 2.0),
                &m,
                &mut path,
            );
        }
        "circle" => {
            let r = num("r");
            if r > 0.0 {
                ellipse(num("cx"), num("cy"), r, r, &m, &mut path);
            }
        }
        "ellipse" => {
            let (rx, ry) = (num("rx"), num("ry"));
            if rx > 0.0 && ry > 0.0 {
                ellipse(num("cx"), num("cy"), rx, ry, &m, &mut path);
            }
        }
        "line" => {
            path.push(VERB_MOVE, &m, &[(num("x1"), num("y1"))]);
            path.push(VERB_LINE, &m, &[(num("x2"), num("y2"))]);
        }
        "polyline" | "polygon" => {
            let pts = numbers(attr_str(attrs, "points").unwrap_or(""))?;
            for (i, [x, y]) in pts.as_chunks::<2>().0.iter().enumerate() {
                let verb = if i == 0 { VERB_MOVE } else { VERB_LINE };
                path.push(verb, &m, &[(*x, *y)]);
            }
            if tag == "polygon" && !path.verbs.is_empty() {
                path.verbs.push(VERB_CLOSE);
            }
        }
        "title" | "desc" | "metadata" => return Ok(()),
        other => return Err(format!("svg: <{other}> is not drawn by orbit")),
    }
    if path.verbs.is_empty() {
        return Ok(());
    }
    // A line has no inside: only its stroke shows.
    let fill = if tag == "line" {
        0
    } else {
        argb(st.fill, current, st.fill_opacity * st.opacity)
    };
    let stroke = argb(st.stroke, current, st.stroke_opacity * st.opacity);
    if fill == 0 && (stroke == 0 || st.stroke_width == 0.0) {
        return Ok(());
    }
    out.extend_from_slice(&fill.to_le_bytes());
    out.push(st.fill_rule);
    out.extend_from_slice(&stroke.to_le_bytes());
    out.extend_from_slice(&((st.stroke_width * m.scale()) as f32).to_le_bytes());
    out.push(st.cap);
    out.push(st.join);
    out.extend_from_slice(&(st.miter as f32).to_le_bytes());
    out.push(u8::from(st.crisp));
    out.extend_from_slice(&(path.verbs.len() as i32).to_le_bytes());
    let mut p = 0;
    for verb in path.verbs {
        out.push(verb);
        let n = match verb {
            VERB_MOVE | VERB_LINE => 2,
            VERB_CUBIC => 6,
            VERB_QUAD => 4,
            _ => 0,
        };
        for v in &path.points[p..p + n] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        p += n;
    }
    *count += 1;
    Ok(())
}

/// A paint as ARGB with `opacity` folded into its alpha; 0 for none.
fn argb(paint: PaintValue, current: u32, opacity: f64) -> i32 {
    let color = match paint {
        PaintValue::None => return 0,
        PaintValue::Current => current,
        PaintValue::Color(c) => c,
    };
    let alpha = (f64::from(color >> 24) * opacity).round() as u32;
    if alpha == 0 {
        return 0;
    }
    ((alpha << 24) | (color & 0x00FF_FFFF)) as i32
}

// ------------------------------------------------------------------ shapes

/// The cubic Bezier that best follows a quarter circle, as a fraction of r.
const KAPPA: f64 = 0.552_284_749_830_793_6;

fn ellipse(cx: f64, cy: f64, rx: f64, ry: f64, m: &Matrix, out: &mut PathOut) {
    let (kx, ky) = (rx * KAPPA, ry * KAPPA);
    out.push(VERB_MOVE, m, &[(cx + rx, cy)]);
    out.push(
        VERB_CUBIC,
        m,
        &[(cx + rx, cy + ky), (cx + kx, cy + ry), (cx, cy + ry)],
    );
    out.push(
        VERB_CUBIC,
        m,
        &[(cx - kx, cy + ry), (cx - rx, cy + ky), (cx - rx, cy)],
    );
    out.push(
        VERB_CUBIC,
        m,
        &[(cx - rx, cy - ky), (cx - kx, cy - ry), (cx, cy - ry)],
    );
    out.push(
        VERB_CUBIC,
        m,
        &[(cx + kx, cy - ry), (cx + rx, cy - ky), (cx + rx, cy)],
    );
    out.verbs.push(VERB_CLOSE);
}

#[allow(clippy::too_many_arguments)]
fn rect(x: f64, y: f64, w: f64, h: f64, rx: f64, ry: f64, m: &Matrix, out: &mut PathOut) {
    if rx <= 0.0 || ry <= 0.0 {
        out.push(VERB_MOVE, m, &[(x, y)]);
        out.push(VERB_LINE, m, &[(x + w, y)]);
        out.push(VERB_LINE, m, &[(x + w, y + h)]);
        out.push(VERB_LINE, m, &[(x, y + h)]);
        out.verbs.push(VERB_CLOSE);
        return;
    }
    let (kx, ky) = (rx * KAPPA, ry * KAPPA);
    let (r, b) = (x + w, y + h);
    out.push(VERB_MOVE, m, &[(x + rx, y)]);
    out.push(VERB_LINE, m, &[(r - rx, y)]);
    out.push(
        VERB_CUBIC,
        m,
        &[(r - rx + kx, y), (r, y + ry - ky), (r, y + ry)],
    );
    out.push(VERB_LINE, m, &[(r, b - ry)]);
    out.push(
        VERB_CUBIC,
        m,
        &[(r, b - ry + ky), (r - rx + kx, b), (r - rx, b)],
    );
    out.push(VERB_LINE, m, &[(x + rx, b)]);
    out.push(
        VERB_CUBIC,
        m,
        &[(x + rx - kx, b), (x, b - ry + ky), (x, b - ry)],
    );
    out.push(VERB_LINE, m, &[(x, y + ry)]);
    out.push(
        VERB_CUBIC,
        m,
        &[(x, y + ry - ky), (x + rx - kx, y), (x + rx, y)],
    );
    out.verbs.push(VERB_CLOSE);
}

// ------------------------------------------------------------------ numbers

/// A reader over SVG's number lists: `4.3-4.3`, `.5.5`, `1e-3`, commas or spaces.
struct Scanner<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Scanner<'a> {
    fn new(s: &'a str) -> Self {
        Scanner {
            s: s.as_bytes(),
            i: 0,
        }
    }

    fn skip_separators(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r' | b',')
        {
            self.i += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_separators();
        self.s.get(self.i).copied()
    }

    fn at_number(&mut self) -> bool {
        matches!(self.peek(), Some(b'0'..=b'9' | b'.' | b'-' | b'+'))
    }

    fn number(&mut self) -> Result<f64, String> {
        self.skip_separators();
        let start = self.i;
        let s = self.s;
        if matches!(s.get(self.i), Some(b'-' | b'+')) {
            self.i += 1;
        }
        let mut digits = 0;
        while matches!(s.get(self.i), Some(b'0'..=b'9')) {
            self.i += 1;
            digits += 1;
        }
        if s.get(self.i) == Some(&b'.') {
            self.i += 1;
            while matches!(s.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
                digits += 1;
            }
        }
        if digits > 0 && matches!(s.get(self.i), Some(b'e' | b'E')) {
            let save = self.i;
            self.i += 1;
            if matches!(s.get(self.i), Some(b'-' | b'+')) {
                self.i += 1;
            }
            if matches!(s.get(self.i), Some(b'0'..=b'9')) {
                while matches!(s.get(self.i), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            } else {
                self.i = save;
            }
        }
        if digits == 0 {
            return Err(format!("svg: a number was expected at {start}"));
        }
        std::str::from_utf8(&s[start..self.i])
            .ok()
            .and_then(|t| t.parse().ok())
            .ok_or_else(|| format!("svg: unreadable number at {start}"))
    }

    /// An arc flag: one `0` or `1`, which may touch what follows (`a1 1 0 011 1`).
    fn flag(&mut self) -> Result<bool, String> {
        match self.peek() {
            Some(b'0') => {
                self.i += 1;
                Ok(false)
            }
            Some(b'1') => {
                self.i += 1;
                Ok(true)
            }
            _ => Err(format!("svg: an arc flag was expected at {}", self.i)),
        }
    }
}

fn numbers(text: &str) -> Result<Vec<f64>, String> {
    let mut sc = Scanner::new(text);
    let mut out = Vec::new();
    while sc.peek().is_some() {
        out.push(sc.number()?);
    }
    Ok(out)
}

/// A `transform` attribute: a list of matrix / translate / scale / rotate / skewX / skewY.
fn transform(text: &str) -> Result<Matrix, String> {
    let mut m = Matrix::IDENTITY;
    let mut rest = text.trim();
    while !rest.is_empty() {
        let open = rest
            .find('(')
            .ok_or_else(|| format!("svg: transform {text:?}"))?;
        let close = rest
            .find(')')
            .ok_or_else(|| format!("svg: transform {text:?}"))?;
        let name = rest[..open].trim().trim_start_matches(',').trim();
        let a = numbers(&rest[open + 1..close])?;
        let get = |i: usize| a.get(i).copied();
        let t = match (name, a.len()) {
            ("matrix", 6) => Matrix([a[0], a[1], a[2], a[3], a[4], a[5]]),
            ("translate", 1 | 2) => Matrix([1.0, 0.0, 0.0, 1.0, a[0], get(1).unwrap_or(0.0)]),
            ("scale", 1 | 2) => Matrix([a[0], 0.0, 0.0, get(1).unwrap_or(a[0]), 0.0, 0.0]),
            ("rotate", 1 | 3) => {
                let (s, c) = a[0].to_radians().sin_cos();
                let r = Matrix([c, s, -s, c, 0.0, 0.0]);
                match (get(1), get(2)) {
                    (Some(cx), Some(cy)) => Matrix([1.0, 0.0, 0.0, 1.0, cx, cy])
                        .then(r)
                        .then(Matrix([1.0, 0.0, 0.0, 1.0, -cx, -cy])),
                    _ => r,
                }
            }
            ("skewX", 1) => Matrix([1.0, 0.0, a[0].to_radians().tan(), 1.0, 0.0, 0.0]),
            ("skewY", 1) => Matrix([1.0, a[0].to_radians().tan(), 0.0, 1.0, 0.0, 0.0]),
            _ => return Err(format!("svg: transform {name}({}) is not read", a.len())),
        };
        m = m.then(t);
        rest = rest[close + 1..].trim();
    }
    Ok(m)
}

// ------------------------------------------------------------------ path data

/// Path data (`d`), every command made absolute and reduced to move, line,
/// cubic, quad and close.
fn path_data(d: &str, m: &Matrix, out: &mut PathOut) -> Result<(), String> {
    let mut sc = Scanner::new(d);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut sx, mut sy) = (0.0f64, 0.0f64);
    // The last control point, for S and T, and which kind it came from.
    let mut last_cubic: Option<(f64, f64)> = None;
    let mut last_quad: Option<(f64, f64)> = None;
    let mut cmd: Option<u8> = None;
    while let Some(c) = sc.peek() {
        let command = if c.is_ascii_alphabetic() {
            sc.i += 1;
            c
        } else {
            match cmd {
                // Coordinates after a moveto are implicit linetos.
                Some(b'M') => b'L',
                Some(b'm') => b'l',
                Some(prev) if prev != b'Z' && prev != b'z' => prev,
                _ => {
                    return Err(format!(
                        "svg: path data {d:?} does not start with a command"
                    ))
                }
            }
        };
        let rel = command.is_ascii_lowercase();
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        let mut cubic_ctrl = None;
        let mut quad_ctrl = None;
        match command.to_ascii_uppercase() {
            b'M' => {
                x = ox + sc.number()?;
                y = oy + sc.number()?;
                (sx, sy) = (x, y);
                out.push(VERB_MOVE, m, &[(x, y)]);
            }
            b'L' => {
                x = ox + sc.number()?;
                y = oy + sc.number()?;
                out.push(VERB_LINE, m, &[(x, y)]);
            }
            b'H' => {
                x = ox + sc.number()?;
                out.push(VERB_LINE, m, &[(x, y)]);
            }
            b'V' => {
                y = (if rel { y } else { 0.0 }) + sc.number()?;
                out.push(VERB_LINE, m, &[(x, y)]);
            }
            b'C' => {
                let p1 = (ox + sc.number()?, oy + sc.number()?);
                let p2 = (ox + sc.number()?, oy + sc.number()?);
                (x, y) = (ox + sc.number()?, oy + sc.number()?);
                out.push(VERB_CUBIC, m, &[p1, p2, (x, y)]);
                cubic_ctrl = Some(p2);
            }
            b'S' => {
                let p1 = match last_cubic {
                    Some((cx, cy)) => (2.0 * x - cx, 2.0 * y - cy),
                    None => (x, y),
                };
                let p2 = (ox + sc.number()?, oy + sc.number()?);
                (x, y) = (ox + sc.number()?, oy + sc.number()?);
                out.push(VERB_CUBIC, m, &[p1, p2, (x, y)]);
                cubic_ctrl = Some(p2);
            }
            b'Q' => {
                let p1 = (ox + sc.number()?, oy + sc.number()?);
                (x, y) = (ox + sc.number()?, oy + sc.number()?);
                out.push(VERB_QUAD, m, &[p1, (x, y)]);
                quad_ctrl = Some(p1);
            }
            b'T' => {
                let p1 = match last_quad {
                    Some((cx, cy)) => (2.0 * x - cx, 2.0 * y - cy),
                    None => (x, y),
                };
                (x, y) = (ox + sc.number()?, oy + sc.number()?);
                out.push(VERB_QUAD, m, &[p1, (x, y)]);
                quad_ctrl = Some(p1);
            }
            b'A' => {
                let rx = sc.number()?.abs();
                let ry = sc.number()?.abs();
                let rotation = sc.number()?;
                let large = sc.flag()?;
                let sweep = sc.flag()?;
                let (ex, ey) = (ox + sc.number()?, oy + sc.number()?);
                arc((x, y), rx, ry, rotation, large, sweep, (ex, ey), m, out);
                (x, y) = (ex, ey);
            }
            b'Z' => {
                out.verbs.push(VERB_CLOSE);
                (x, y) = (sx, sy);
            }
            other => return Err(format!("svg: path command {:?} is not read", other as char)),
        }
        last_cubic = cubic_ctrl;
        last_quad = quad_ctrl;
        cmd = Some(command);
        // A command letter must come next unless more coordinates follow.
        if !sc.at_number() && !matches!(sc.peek(), None | Some(b'A'..=b'Z' | b'a'..=b'z')) {
            return Err(format!("svg: unreadable path data at {}", sc.i));
        }
    }
    Ok(())
}

/// An elliptical arc as cubics (SVG 1.1 F.6: endpoint to center
/// parameterization, then at most a quarter turn per cubic).
#[allow(clippy::too_many_arguments)]
fn arc(
    from: (f64, f64),
    mut rx: f64,
    mut ry: f64,
    rotation: f64,
    large: bool,
    sweep: bool,
    to: (f64, f64),
    m: &Matrix,
    out: &mut PathOut,
) {
    if from == to {
        return;
    }
    if rx == 0.0 || ry == 0.0 {
        out.push(VERB_LINE, m, &[to]);
        return;
    }
    let (sin, cos) = rotation.to_radians().sin_cos();
    let dx = (from.0 - to.0) / 2.0;
    let dy = (from.1 - to.1) / 2.0;
    let x1 = cos * dx + sin * dy;
    let y1 = -sin * dx + cos * dy;
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut coef = (num / den).max(0.0).sqrt();
    if large == sweep {
        coef = -coef;
    }
    let cx1 = coef * rx * y1 / ry;
    let cy1 = -coef * ry * x1 / rx;
    let cx = cos * cx1 - sin * cy1 + (from.0 + to.0) / 2.0;
    let cy = sin * cx1 + cos * cy1 + (from.1 + to.1) / 2.0;
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let theta = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut delta = angle(
        (x1 - cx1) / rx,
        (y1 - cy1) / ry,
        (-x1 - cx1) / rx,
        (-y1 - cy1) / ry,
    );
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    let segments = (delta.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
    let step = delta / segments as f64;
    let k = 4.0 / 3.0 * (step / 4.0).tan();
    let point = |t: f64| {
        let (s, c) = t.sin_cos();
        (
            cx + rx * c * cos - ry * s * sin,
            cy + rx * c * sin + ry * s * cos,
        )
    };
    let derivative = |t: f64| {
        let (s, c) = t.sin_cos();
        (-rx * s * cos - ry * c * sin, -rx * s * sin + ry * c * cos)
    };
    let mut t = theta;
    for i in 0..segments {
        let t2 = t + step;
        let p0 = point(t);
        let p3 = if i + 1 == segments { to } else { point(t2) };
        let d0 = derivative(t);
        let d3 = derivative(t2);
        let p1 = (p0.0 + k * d0.0, p0.1 + k * d0.1);
        let p2 = (p3.0 - k * d3.0, p3.1 - k * d3.1);
        out.push(VERB_CUBIC, m, &[p1, p2, p3]);
        t = t2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn path_of(d: &str) -> (Vec<u8>, Vec<f32>) {
        let mut out = PathOut::default();
        path_data(d, &Matrix::IDENTITY, &mut out).unwrap();
        (out.verbs, out.points)
    }

    #[test]
    fn reads_compact_numbers_and_relative_commands() {
        // Lucide's search handle: `m21 21-4.3-4.3`.
        let (verbs, points) = path_of("m21 21-4.3-4.3");
        assert_eq!(verbs, vec![VERB_MOVE, VERB_LINE]);
        assert!((points[2] - 16.7).abs() < 1e-5 && (points[3] - 16.7).abs() < 1e-5);
        let (_, points) = path_of("M12 8h.01");
        assert!((points[2] - 12.01).abs() < 1e-5);
        assert_eq!(numbers(".5.5-1e2,3").unwrap(), vec![0.5, 0.5, -100.0, 3.0]);
        // Implicit lineto after a moveto, and V relative to the current point.
        let (verbs, points) = path_of("M0 0 10 0v5z");
        assert_eq!(verbs, vec![VERB_MOVE, VERB_LINE, VERB_LINE, VERB_CLOSE]);
        assert_eq!(&points[4..6], &[10.0, 5.0]);
        assert!(path_data("X1", &Matrix::IDENTITY, &mut PathOut::default()).is_err());
        assert!(path_data("10 10", &Matrix::IDENTITY, &mut PathOut::default()).is_err());
    }

    #[test]
    fn turns_an_arc_into_cubics_that_end_on_its_endpoint() {
        // Lucide's loader: three quarters of a circle of radius 9.
        let (verbs, points) = path_of("M21 12a9 9 0 1 1-6.219-8.56");
        assert_eq!(verbs[0], VERB_MOVE);
        assert!(verbs[1..].iter().all(|&v| v == VERB_CUBIC));
        assert_eq!(verbs.len() - 1, 4);
        let end = &points[points.len() - 2..];
        assert!((end[0] - 14.781).abs() < 1e-3 && (end[1] - 3.44).abs() < 1e-3);
        // Every on-curve point sits on the circle around (12, 12).
        for seg in 0..4 {
            let base = 2 + seg * 6 + 4;
            let (x, y) = (points[base] - 12.0, points[base + 1] - 12.0);
            assert!(((x * x + y * y).sqrt() - 9.0).abs() < 1e-3);
        }
        // Flags that touch the numbers after them.
        let (verbs, _) = path_of("M0 0a5 5 0 015 5");
        assert_eq!(verbs, vec![VERB_MOVE, VERB_CUBIC]);
    }

    #[test]
    fn smooth_curves_reflect_the_previous_control_point() {
        let (verbs, points) = path_of("M0 0C0 10 10 10 10 0S20 -10 20 0");
        assert_eq!(verbs, vec![VERB_MOVE, VERB_CUBIC, VERB_CUBIC]);
        assert_eq!(&points[8..10], &[10.0, -10.0]);
        let (_, points) = path_of("M0 0Q5 10 10 0T20 0");
        assert_eq!(&points[6..8], &[15.0, -10.0]);
    }

    #[test]
    fn applies_transforms() {
        let m = transform("translate(10 20) scale(2)").unwrap();
        assert_eq!(m.apply(1.0, 1.0), (12.0, 22.0));
        let r = transform("rotate(90 5 5)").unwrap();
        let (x, y) = r.apply(10.0, 5.0);
        assert!((x - 5.0).abs() < 1e-9 && (y - 10.0).abs() < 1e-9);
        assert!(transform("perspective(3)").is_err());
    }

    fn shapes(v: Value) -> Vec<(i32, i32, f32, usize)> {
        let buf = encode(&v).unwrap();
        let i32_at = |i: usize| i32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
        let f32_at = |i: usize| f32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]);
        let count = i32_at(17);
        let mut i = 21;
        let mut out = Vec::new();
        for _ in 0..count {
            let fill = i32_at(i);
            let stroke = i32_at(i + 5);
            let width = f32_at(i + 9);
            let verbs = i32_at(i + 20) as usize;
            i += 24;
            for _ in 0..verbs {
                let n = match buf[i] {
                    VERB_MOVE | VERB_LINE => 2,
                    VERB_CUBIC => 6,
                    VERB_QUAD => 4,
                    _ => 0,
                };
                i += 1 + 4 * n;
            }
            out.push((fill, stroke, width, verbs));
        }
        assert_eq!(i, buf.len());
        out
    }

    #[test]
    fn resolves_inheritance_current_color_and_opacity() {
        let red = 0xFFFF_0000u32 as i64;
        let v = json!({
            "color": red,
            "root": { "t": "svg", "a": { "viewBox": "0 0 24 24", "fill": "none", "stroke": "currentColor", "stroke-width": "2" },
              "c": [
                { "t": "path", "a": { "d": "M20 6 9 17l-5-5" } },
                { "t": "g", "a": { "transform": "scale(2)", "opacity": "0.5" }, "c": [
                    { "t": "circle", "a": { "cx": "12", "cy": "12", "r": "4", "fill": "currentColor", "stroke": "none" } }
                ]},
                { "t": "rect", "a": { "width": "18", "height": "18", "x": "3", "y": "4", "rx": "2" } },
                { "t": "title" }
              ]}
        });
        let s = shapes(v);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], (0, red as i32, 2.0, 3));
        // currentColor fill at half opacity, no stroke.
        assert_eq!(s[1].0 as u32, 0x80FF_0000);
        assert_eq!(s[1].1, 0);
        // A rounded rect: four sides and four corners.
        assert_eq!(s[2].3, 10);
    }

    #[test]
    fn refuses_what_it_does_not_draw() {
        let v = json!({ "root": { "t": "svg", "a": { "viewBox": "0 0 1 1" }, "c": [ { "t": "text" } ] } });
        assert!(encode(&v).unwrap_err().contains("<text>"));
        let v = json!({ "root": { "t": "svg", "a": { "viewBox": "0 0 0 1" } } });
        assert!(encode(&v).is_err());
    }
}
