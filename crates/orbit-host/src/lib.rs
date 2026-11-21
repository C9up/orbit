//! orbit-host — orbit's native host under aurora.
//!
//! JS (aurora's native renderer) commits a batch of tree operations as JSON:
//!   ["c", tag, viewName, props]   create a node
//!   ["u", tag, props]             merge a props patch
//!   ["k", tag, [childTags]]       replace a node's children
//!   ["r", tag]                    set the root
//! The host keeps the tree, lays it out with taffy (text measured by the
//! platform through a callback), diffs it against what is mounted, and returns
//! a compact binary list of mount operations for the platform layer (Kotlin)
//! to apply to real views. Nodes no longer reachable from the root are dropped
//! and their tags reported back so JS can forget them.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::time::Instant;

pub mod gesture;
pub mod motion;
pub mod vector;

use serde_json::{Map, Value};
use taffy::prelude::*;

/// Measures encoded text (see `encode_text`) under a maximum width, in dp.
/// Returns the width and height as the high and low 32 bits of f32 bit patterns.
pub type MeasureFn = extern "C" fn(spans: *const u8, len: usize, max_width: f32) -> u64;

// Mount operation codes, shared with OrbitHost.kt.
const OP_CREATE: u8 = 1;
const OP_DELETE: u8 = 2;
const OP_CHILDREN: u8 = 3;
const OP_FRAME: u8 = 4;
const OP_VIEW_STYLE: u8 = 5;
const OP_TEXT: u8 = 6;
const OP_ROOT: u8 = 7;
const OP_INPUT: u8 = 8;
const OP_IMAGE: u8 = 9;
const OP_EFFECTS: u8 = 10;
const OP_VECTOR: u8 = 11;

const KIND_VIEW: u8 = 0;
const KIND_TEXT: u8 = 1;
const KIND_SCROLL: u8 = 2;
const KIND_INPUT: u8 = 3;
const KIND_IMAGE: u8 = 4;
const KIND_VECTOR: u8 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    View,
    Scroll,
    Text,
    RawText,
    VirtualText,
    /// A native text field: a layout leaf the platform measures by its font.
    TextInput,
    /// An image: a layout leaf sized by its style alone, decoded by the platform.
    Image,
    /// An `<svg>`: a layout leaf sized by its style, drawn from `vector.rs`'s paths.
    Vector,
}

impl Kind {
    fn of(view_name: &str) -> Kind {
        match view_name {
            "RCTText" | "RCTParagraph" => Kind::Text,
            "RCTRawText" => Kind::RawText,
            "RCTVirtualText" => Kind::VirtualText,
            "RCTScrollView" => Kind::Scroll,
            "OrbitTextInput" => Kind::TextInput,
            "OrbitImage" => Kind::Image,
            "OrbitVector" => Kind::Vector,
            _ => Kind::View,
        }
    }
    fn is_layout(self) -> bool {
        matches!(
            self,
            Kind::View | Kind::Scroll | Kind::Text | Kind::TextInput | Kind::Image | Kind::Vector
        )
    }
}

#[derive(Clone, Default, PartialEq, Debug)]
struct TextStyle {
    color: Option<i32>,
    size: Option<f32>,
    bold: Option<bool>,
    italic: Option<bool>,
    line_height: Option<f32>,
    align: Option<u8>,
}

impl TextStyle {
    fn over(&self, base: &TextStyle) -> TextStyle {
        TextStyle {
            color: self.color.or(base.color),
            size: self.size.or(base.size),
            bold: self.bold.or(base.bold),
            italic: self.italic.or(base.italic),
            line_height: self.line_height.or(base.line_height),
            align: self.align.or(base.align),
        }
    }
}

#[derive(Clone, Default, PartialEq, Debug)]
struct Visual {
    background: Option<i32>,
    border_color: Option<i32>,
    border_width: f32,
    radius: f32,
    opacity: f32,
}

struct Node {
    kind: Kind,
    props: Map<String, Value>,
    taffy: Option<NodeId>,
    children: Vec<i32>,
    text: String,
    /// A vector node's drawing, encoded when its `vector` prop is set.
    vector: Vec<u8>,
}

/// What a view draws beyond its box: a CSS box shadow, a backdrop blur, and
/// whether it clips its children (`overflow: hidden`).
#[derive(Clone, Default, PartialEq, Debug)]
struct Effects {
    shadow_x: f32,
    shadow_y: f32,
    shadow_blur: f32,
    shadow_spread: f32,
    shadow_color: i32,
    backdrop_blur: f32,
    clip: bool,
}

#[derive(Default)]
struct Mounted {
    frame: [f32; 4],
    visual: Option<Visual>,
    effects: Option<Effects>,
    text: Vec<u8>,
    children: Vec<i32>,
}

#[derive(Default, Debug)]
pub struct CommitInfo {
    pub deleted: Vec<i32>,
    pub parse_us: u128,
    pub layout_us: u128,
    pub diff_us: u128,
    pub measures: u32,
    pub nodes: usize,
}

pub struct Host {
    nodes: HashMap<i32, Node>,
    parent: HashMap<i32, i32>,
    tree: TaffyTree<i32>,
    root: Option<i32>,
    mounted_root: Option<i32>,
    mounted: HashMap<i32, Mounted>,
    spans: HashMap<i32, Vec<u8>>,
    measure_cache: HashMap<(u64, u32), (f32, f32)>,
    viewport: (f32, f32),
    measure: Option<MeasureFn>,
}

impl Default for Host {
    fn default() -> Self {
        Host {
            nodes: HashMap::new(),
            parent: HashMap::new(),
            tree: TaffyTree::new(),
            root: None,
            mounted_root: None,
            mounted: HashMap::new(),
            spans: HashMap::new(),
            measure_cache: HashMap::new(),
            viewport: (400.0, 800.0),
            measure: None,
        }
    }
}

// ---------------------------------------------------------------- props -> style

fn num(v: &Value) -> Option<f32> {
    match v {
        Value::Number(n) => n.as_f64().map(|f| f as f32),
        Value::String(s) => s.trim_end_matches("px").parse::<f32>().ok(),
        _ => None,
    }
}

fn color(v: &Value) -> Option<i32> {
    v.as_i64().map(|n| n as i32)
}

fn dimension(v: &Value) -> Dimension {
    match v {
        Value::String(s) if s.ends_with('%') => s
            .trim_end_matches('%')
            .parse::<f32>()
            .map(|p| Dimension::percent(p / 100.0))
            .unwrap_or(Dimension::auto()),
        Value::String(s) if s == "auto" => Dimension::auto(),
        _ => num(v).map(Dimension::length).unwrap_or(Dimension::auto()),
    }
}

fn length_percentage(v: &Value) -> LengthPercentage {
    match v {
        Value::String(s) if s.ends_with('%') => s
            .trim_end_matches('%')
            .parse::<f32>()
            .map(|p| LengthPercentage::percent(p / 100.0))
            .unwrap_or(LengthPercentage::length(0.0)),
        _ => LengthPercentage::length(num(v).unwrap_or(0.0)),
    }
}

fn length_percentage_auto(v: &Value) -> LengthPercentageAuto {
    match v {
        Value::String(s) if s == "auto" => LengthPercentageAuto::auto(),
        Value::String(s) if s.ends_with('%') => s
            .trim_end_matches('%')
            .parse::<f32>()
            .map(|p| LengthPercentageAuto::percent(p / 100.0))
            .unwrap_or(LengthPercentageAuto::length(0.0)),
        _ => LengthPercentageAuto::length(num(v).unwrap_or(0.0)),
    }
}

fn align(v: &Value) -> Option<AlignItems> {
    match v.as_str()? {
        "flex-start" | "start" => Some(AlignItems::FlexStart),
        "flex-end" | "end" => Some(AlignItems::FlexEnd),
        "center" => Some(AlignItems::Center),
        "stretch" => Some(AlignItems::Stretch),
        "baseline" => Some(AlignItems::Baseline),
        _ => None,
    }
}

fn justify(v: &Value) -> Option<JustifyContent> {
    match v.as_str()? {
        "flex-start" | "start" => Some(JustifyContent::FlexStart),
        "flex-end" | "end" => Some(JustifyContent::FlexEnd),
        "center" => Some(JustifyContent::Center),
        "space-between" => Some(JustifyContent::SpaceBetween),
        "space-around" => Some(JustifyContent::SpaceAround),
        "space-evenly" => Some(JustifyContent::SpaceEvenly),
        _ => None,
    }
}

/// Four-sided shorthand in React Native's precedence: side > axis > all.
fn sides<T: Copy>(
    props: &Map<String, Value>,
    prefix: &str,
    suffix: &str,
    zero: T,
    parse: fn(&Value) -> T,
) -> Rect<T> {
    let get = |name: &str| props.get(&format!("{prefix}{name}{suffix}")).map(parse);
    let all = get("").unwrap_or(zero);
    let horizontal = get("Horizontal").unwrap_or(all);
    let vertical = get("Vertical").unwrap_or(all);
    Rect {
        left: get("Left").or_else(|| get("Start")).unwrap_or(horizontal),
        right: get("Right").or_else(|| get("End")).unwrap_or(horizontal),
        top: get("Top").unwrap_or(vertical),
        bottom: get("Bottom").unwrap_or(vertical),
    }
}

fn style_of(props: &Map<String, Value>) -> Style {
    // React Native's defaults, not CSS's: column, no shrink.
    let mut s = Style {
        flex_direction: FlexDirection::Column,
        flex_shrink: 0.0,
        ..Style::default()
    };
    if let Some(v) = props.get("flexDirection").and_then(Value::as_str) {
        s.flex_direction = match v {
            "row" => FlexDirection::Row,
            "row-reverse" => FlexDirection::RowReverse,
            "column-reverse" => FlexDirection::ColumnReverse,
            _ => FlexDirection::Column,
        };
    }
    if props.get("flexWrap").and_then(Value::as_str) == Some("wrap") {
        s.flex_wrap = FlexWrap::Wrap;
    }
    if let Some(f) = props.get("flex").and_then(num) {
        if f > 0.0 {
            s.flex_grow = f;
            s.flex_shrink = 1.0;
            s.flex_basis = Dimension::length(0.0);
        }
    }
    if let Some(f) = props.get("flexGrow").and_then(num) {
        s.flex_grow = f;
    }
    if let Some(f) = props.get("flexShrink").and_then(num) {
        s.flex_shrink = f;
    }
    if let Some(v) = props.get("flexBasis") {
        s.flex_basis = dimension(v);
    }
    s.align_items = props.get("alignItems").and_then(align);
    s.align_self = props.get("alignSelf").and_then(align);
    s.justify_content = props.get("justifyContent").and_then(justify);
    for (key, slot) in [
        ("width", &mut s.size.width),
        ("height", &mut s.size.height),
        ("minWidth", &mut s.min_size.width),
        ("minHeight", &mut s.min_size.height),
        ("maxWidth", &mut s.max_size.width),
        ("maxHeight", &mut s.max_size.height),
    ] {
        if let Some(v) = props.get(key) {
            *slot = dimension(v);
        }
    }
    s.padding = sides(
        props,
        "padding",
        "",
        LengthPercentage::length(0.0),
        length_percentage,
    );
    s.margin = sides(
        props,
        "margin",
        "",
        LengthPercentageAuto::length(0.0),
        length_percentage_auto,
    );
    s.border = sides(
        props,
        "border",
        "Width",
        LengthPercentage::length(0.0),
        length_percentage,
    );
    let gap = props
        .get("gap")
        .map(length_percentage)
        .unwrap_or(LengthPercentage::length(0.0));
    s.gap = Size {
        width: props.get("columnGap").map(length_percentage).unwrap_or(gap),
        height: props.get("rowGap").map(length_percentage).unwrap_or(gap),
    };
    if props.get("position").and_then(Value::as_str) == Some("absolute") {
        s.position = Position::Absolute;
    }
    s.inset = Rect {
        left: props
            .get("left")
            .map(length_percentage_auto)
            .unwrap_or(LengthPercentageAuto::auto()),
        right: props
            .get("right")
            .map(length_percentage_auto)
            .unwrap_or(LengthPercentageAuto::auto()),
        top: props
            .get("top")
            .map(length_percentage_auto)
            .unwrap_or(LengthPercentageAuto::auto()),
        bottom: props
            .get("bottom")
            .map(length_percentage_auto)
            .unwrap_or(LengthPercentageAuto::auto()),
    };
    s.aspect_ratio = props.get("aspectRatio").and_then(num);
    if props.get("display").and_then(Value::as_str) == Some("none") {
        s.display = Display::None;
    }
    s
}

/// A scroll view does not grow to its content: its content child does, and
/// the platform scrolls that child inside the view's frame.
fn style_for(kind: Kind, props: &Map<String, Value>) -> Style {
    let mut s = style_of(props);
    if kind == Kind::Scroll {
        s.overflow = taffy::geometry::Point {
            x: taffy::style::Overflow::Visible,
            y: taffy::style::Overflow::Scroll,
        };
        s.scrollbar_width = 0.0;
    }
    s
}

fn visual_of(props: &Map<String, Value>) -> Visual {
    Visual {
        background: props.get("backgroundColor").and_then(color),
        border_color: props.get("borderColor").and_then(color),
        border_width: props.get("borderWidth").and_then(num).unwrap_or(0.0),
        radius: props.get("borderRadius").and_then(num).unwrap_or(0.0),
        opacity: props.get("opacity").and_then(num).unwrap_or(1.0),
    }
}

/// The gestures a node's handlers ask for (see `gesture`).
fn gesture_flags(props: &Map<String, Value>) -> u8 {
    props
        .get("gestures")
        .and_then(Value::as_u64)
        .map(|n| (n & 0xff) as u8)
        .unwrap_or(0)
}

fn effects_of(props: &Map<String, Value>) -> Effects {
    let length = |key: &str| props.get(key).and_then(num).unwrap_or(0.0);
    Effects {
        shadow_x: length("shadowX"),
        shadow_y: length("shadowY"),
        shadow_blur: length("shadowBlur").max(0.0),
        shadow_spread: length("shadowSpread"),
        shadow_color: props.get("shadowColor").and_then(color).unwrap_or(0),
        backdrop_blur: length("backdropBlur").max(0.0),
        clip: props.get("overflow").and_then(Value::as_str) == Some("hidden"),
    }
}

fn text_style_of(props: &Map<String, Value>) -> TextStyle {
    TextStyle {
        color: props.get("color").and_then(color),
        size: props.get("fontSize").and_then(num),
        bold: props.get("fontWeight").map(|w| match w {
            Value::String(s) => s == "bold" || s.parse::<u32>().map(|n| n >= 600).unwrap_or(false),
            Value::Number(n) => n.as_f64().map(|n| n >= 600.0).unwrap_or(false),
            _ => false,
        }),
        italic: props
            .get("fontStyle")
            .and_then(Value::as_str)
            .map(|s| s == "italic"),
        line_height: props.get("lineHeight").and_then(num),
        align: props
            .get("textAlign")
            .and_then(Value::as_str)
            .map(|s| match s {
                "center" => 1,
                "right" => 2,
                _ => 0,
            }),
    }
}

// ---------------------------------------------------------------- encoding

fn put_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn put_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}

const DEFAULT_INPUT_WIDTH: f32 = 160.0;

/// What a text field is measured with: one sample line per row, in its font.
fn encode_input_sample(props: &Map<String, Value>) -> Vec<u8> {
    let style = text_style_of(props);
    let rows = props
        .get("rows")
        .and_then(num)
        .map(|r| r.max(1.0) as usize)
        .unwrap_or(1);
    // Sized by its content (CSS field-sizing): measured on what it holds,
    // wraps included, so it grows with its lines; empty, it keeps its rows.
    let content = props
        .get("measureText")
        .or_else(|| props.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let sized_by_content = props.get("fieldSizing").and_then(Value::as_str) == Some("content");
    let sample = if sized_by_content && !content.is_empty() {
        content.to_owned()
    } else {
        vec!["Mg"; rows].join("\n")
    };
    let mut out = vec![0u8];
    put_f32(&mut out, style.line_height.unwrap_or(0.0));
    put_i32(&mut out, 1);
    put_i32(&mut out, style.color.unwrap_or(0xFF00_0000u32 as i32));
    put_f32(&mut out, style.size.unwrap_or(14.0));
    let flags =
        i32::from(style.bold.unwrap_or(false)) | (i32::from(style.italic.unwrap_or(false)) << 1);
    put_i32(&mut out, flags);
    put_i32(&mut out, sample.len() as i32);
    out.extend_from_slice(sample.as_bytes());
    out
}

/// A text field's mount payload: its props as JSON, plus the padding taffy
/// placed around its text (the platform field insets its text by it).
fn encode_input(props: &Map<String, Value>, layout: &taffy::Layout) -> Vec<u8> {
    let mut field = Map::new();
    for key in [
        "placeholder",
        "placeholderColor",
        "multiline",
        "rows",
        "secure",
        "keyboard",
        "maxLength",
        "editable",
        "autocomplete",
        "text",
        "textVersion",
        "fontSize",
        "color",
        "fontWeight",
        "fontStyle",
        "textAlign",
    ] {
        if let Some(v) = props.get(key) {
            field.insert(key.to_owned(), v.clone());
        }
    }
    let p = layout.padding;
    field.insert(
        "padding".to_owned(),
        serde_json::json!([p.left, p.top, p.right, p.bottom]),
    );
    Value::Object(field).to_string().into_bytes()
}

/// An image's mount payload: where it comes from, how it fits its box, and
/// what a screen reader says. Its frame and corners travel as for any view.
fn encode_image(props: &Map<String, Value>) -> Vec<u8> {
    let text = |key: &str| props.get(key).and_then(Value::as_str).unwrap_or("");
    serde_json::json!({
        "src": text("src"),
        "fit": match text("objectFit") {
            fit @ ("cover" | "contain" | "none" | "scale-down") => fit,
            _ => "fill",
        },
        "alt": text("alt"),
    })
    .to_string()
    .into_bytes()
}

impl Host {
    fn set_measure(&mut self, measure: MeasureFn) {
        self.measure = Some(measure);
    }

    fn set_viewport(&mut self, width: f32, height: f32) {
        self.viewport = (width, height);
    }

    /// The attributed text of a Text node: its runs with inherited styles.
    fn encode_text(&self, tag: i32) -> Vec<u8> {
        if let Some(node) = self.nodes.get(&tag) {
            if node.kind == Kind::TextInput {
                return encode_input_sample(&node.props);
            }
        }
        let mut runs: Vec<(TextStyle, String)> = Vec::new();
        let Some(node) = self.nodes.get(&tag) else {
            return Vec::new();
        };
        let base = text_style_of(&node.props);
        self.collect_runs(&node.children, &base, &mut runs);
        let mut out = Vec::new();
        out.push(base.align.unwrap_or(0));
        put_f32(&mut out, base.line_height.unwrap_or(0.0));
        put_i32(&mut out, runs.len() as i32);
        for (style, text) in runs {
            put_i32(&mut out, style.color.unwrap_or(0xFF00_0000u32 as i32));
            put_f32(&mut out, style.size.unwrap_or(14.0));
            let flags = i32::from(style.bold.unwrap_or(false))
                | (i32::from(style.italic.unwrap_or(false)) << 1);
            put_i32(&mut out, flags);
            put_i32(&mut out, text.len() as i32);
            out.extend_from_slice(text.as_bytes());
        }
        out
    }

    fn collect_runs(
        &self,
        children: &[i32],
        inherited: &TextStyle,
        runs: &mut Vec<(TextStyle, String)>,
    ) {
        for child in children {
            let Some(node) = self.nodes.get(child) else {
                continue;
            };
            match node.kind {
                Kind::RawText => runs.push((inherited.clone(), node.text.clone())),
                Kind::VirtualText | Kind::Text => {
                    let style = text_style_of(&node.props).over(inherited);
                    self.collect_runs(&node.children, &style, runs);
                }
                Kind::View | Kind::Scroll | Kind::TextInput | Kind::Image | Kind::Vector => {}
            }
        }
    }

    /// The Text node a text-bearing node belongs to (itself for a Text).
    fn owning_text(&self, mut tag: i32) -> Option<i32> {
        loop {
            let node = self.nodes.get(&tag)?;
            if matches!(node.kind, Kind::Text | Kind::TextInput) {
                return Some(tag);
            }
            tag = *self.parent.get(&tag)?;
        }
    }

    /// Where nodes were laid out: `[x, y, width, height]` in the root's
    /// coordinates (a scroll view's offset left out), or null for a tag with
    /// no layout. A lazy list reads its rows' heights and its viewport here.
    pub fn frames(&self, tags: &[i32]) -> Vec<Option<[f32; 4]>> {
        tags.iter()
            .map(|&tag| {
                let id = self.nodes.get(&tag)?.taffy?;
                let own = self.tree.layout(id).ok()?;
                let (mut x, mut y) = (own.location.x, own.location.y);
                let mut at = tag;
                while let Some(&parent) = self.parent.get(&at) {
                    if let Some(id) = self.nodes.get(&parent).and_then(|n| n.taffy) {
                        let layout = self.tree.layout(id).ok()?;
                        x += layout.location.x;
                        y += layout.location.y;
                    }
                    at = parent;
                }
                Some([x, y, own.size.width, own.size.height])
            })
            .collect()
    }

    pub fn commit(&mut self, ops_json: &[u8], out: &mut Vec<u8>) -> Result<CommitInfo, String> {
        let mut info = CommitInfo::default();
        let t0 = Instant::now();
        let ops: Vec<Value> = serde_json::from_slice(ops_json).map_err(|e| e.to_string())?;
        let mut text_dirty: HashSet<i32> = HashSet::new();
        let mut touched: Vec<i32> = Vec::new();
        for op in &ops {
            let Some(arr) = op.as_array() else { continue };
            let code = arr.first().and_then(Value::as_str).unwrap_or("");
            let tag = arr.get(1).and_then(Value::as_i64).unwrap_or(0) as i32;
            match code {
                "c" => {
                    let kind = Kind::of(arr.get(2).and_then(Value::as_str).unwrap_or("RCTView"));
                    let props = arr
                        .get(3)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let text = props
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    let vector = match (kind, props.get("vector")) {
                        (Kind::Vector, Some(v)) => vector::encode(v)?,
                        _ => Vec::new(),
                    };
                    if kind.is_layout() {
                        let flags = gesture_flags(&props);
                        gesture::with(|g| g.set_node(tag, flags, kind == Kind::Scroll));
                    }
                    let taffy = if kind.is_layout() {
                        Some(
                            self.tree
                                .new_leaf_with_context(style_for(kind, &props), tag)
                                .map_err(|e| e.to_string())?,
                        )
                    } else {
                        None
                    };
                    self.nodes.insert(
                        tag,
                        Node {
                            kind,
                            props,
                            taffy,
                            children: Vec::new(),
                            text,
                            vector,
                        },
                    );
                    touched.push(tag);
                }
                "u" => {
                    let patch = arr
                        .get(2)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(node) = self.nodes.get_mut(&tag) {
                        if patch.contains_key("gestures") && node.kind.is_layout() {
                            let flags = gesture_flags(&patch);
                            let scroll = node.kind == Kind::Scroll;
                            gesture::with(|g| g.set_node(tag, flags, scroll));
                        }
                        if let Some(t) = patch.get("text").and_then(Value::as_str) {
                            node.text = t.to_owned();
                        }
                        if let (Kind::Vector, Some(v)) = (node.kind, patch.get("vector")) {
                            node.vector = vector::encode(v)?;
                        }
                        node.props.extend(patch);
                        if let Some(id) = node.taffy {
                            self.tree
                                .set_style(id, style_for(node.kind, &node.props))
                                .map_err(|e| e.to_string())?;
                        }
                        touched.push(tag);
                    }
                }
                "k" => {
                    let children: Vec<i32> = arr
                        .get(2)
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_i64)
                                .map(|n| n as i32)
                                .collect()
                        })
                        .unwrap_or_default();
                    for child in &children {
                        self.parent.insert(*child, tag);
                    }
                    gesture::with(|g| {
                        for child in &children {
                            g.set_parent(*child, tag);
                        }
                    });
                    let layout_children: Vec<NodeId> = children
                        .iter()
                        .filter_map(|c| self.nodes.get(c).and_then(|n| n.taffy))
                        .collect();
                    if let Some(node) = self.nodes.get_mut(&tag) {
                        node.children = children;
                        if matches!(node.kind, Kind::View | Kind::Scroll) {
                            if let Some(id) = node.taffy {
                                self.tree
                                    .set_children(id, &layout_children)
                                    .map_err(|e| e.to_string())?;
                            }
                        }
                        touched.push(tag);
                    }
                }
                "r" => self.root = Some(tag),
                _ => {}
            }
        }
        for tag in touched {
            if let Some(text) = self.owning_text(tag) {
                text_dirty.insert(text);
            }
        }
        for text in text_dirty {
            let encoded = self.encode_text(text);
            if self.spans.get(&text) != Some(&encoded) {
                self.spans.insert(text, encoded);
                if let Some(id) = self.nodes.get(&text).and_then(|n| n.taffy) {
                    self.tree.mark_dirty(id).map_err(|e| e.to_string())?;
                }
            }
        }
        info.parse_us = t0.elapsed().as_micros();

        let Some(root) = self.root else {
            return Ok(info);
        };
        let Some(root_id) = self.nodes.get(&root).and_then(|n| n.taffy) else {
            return Ok(info);
        };
        let t1 = Instant::now();
        let mut root_style = self.tree.style(root_id).map_err(|e| e.to_string())?.clone();
        root_style.size = Size {
            width: Dimension::length(self.viewport.0),
            height: Dimension::length(self.viewport.1),
        };
        self.tree
            .set_style(root_id, root_style)
            .map_err(|e| e.to_string())?;
        {
            let inputs: HashSet<i32> = self
                .nodes
                .iter()
                .filter(|(_, n)| n.kind == Kind::TextInput)
                .map(|(t, _)| *t)
                .collect();
            let Host {
                tree,
                spans,
                measure_cache,
                measure,
                ..
            } = self;
            let measure = *measure;
            let mut measures = 0u32;
            tree.compute_layout_with_measure(
                root_id,
                Size {
                    width: AvailableSpace::Definite(self.viewport.0),
                    height: AvailableSpace::Definite(self.viewport.1),
                },
                |known, available, _id, ctx, _style| {
                    if let (Some(w), Some(h)) = (known.width, known.height) {
                        return Size {
                            width: w,
                            height: h,
                        };
                    }
                    let Some(tag) = ctx.map(|t| *t) else {
                        return Size::ZERO;
                    };
                    let Some(encoded) = spans.get(&tag) else {
                        return Size::ZERO;
                    };
                    let max_width = known.width.unwrap_or(match available.width {
                        AvailableSpace::Definite(w) => w,
                        AvailableSpace::MinContent => 0.0,
                        AvailableSpace::MaxContent => f32::INFINITY,
                    });
                    let mut hasher = DefaultHasher::new();
                    encoded.hash(&mut hasher);
                    let hash = hasher.finish();
                    let mut call = |width: f32| {
                        measures += 1;
                        match measure {
                            Some(f) => {
                                let packed = f(encoded.as_ptr(), encoded.len(), width);
                                (
                                    f32::from_bits((packed >> 32) as u32),
                                    f32::from_bits(packed as u32),
                                )
                            }
                            // Desktop tests: 7 dp per byte, 16 dp per line.
                            None => ((encoded.len() as f32 * 7.0).min(width), 16.0),
                        }
                    };
                    // One platform call per text in the common case: its natural
                    // size answers every constraint at least that wide. Only a
                    // narrower constraint (wrapping) costs another call.
                    let natural = *measure_cache
                        .entry((hash, f32::INFINITY.to_bits()))
                        .or_insert_with(|| call(f32::INFINITY));
                    let (w, h) = if max_width >= natural.0 {
                        natural
                    } else {
                        *measure_cache
                            .entry((hash, max_width.to_bits()))
                            .or_insert_with(|| call(max_width))
                    };
                    // A field is as wide as its box says, like an HTML input:
                    // its text does not size it. 160 dp when nothing does.
                    let w = if inputs.contains(&tag) {
                        DEFAULT_INPUT_WIDTH
                    } else {
                        w
                    };
                    Size {
                        width: known.width.unwrap_or(w),
                        height: known.height.unwrap_or(h),
                    }
                },
            )
            .map_err(|e| e.to_string())?;
            info.measures = measures;
        }
        info.layout_us = t1.elapsed().as_micros();

        let t2 = Instant::now();
        let mut reachable: Vec<i32> = Vec::new();
        let mut stack = vec![root];
        while let Some(tag) = stack.pop() {
            let Some(node) = self.nodes.get(&tag) else {
                continue;
            };
            reachable.push(tag);
            stack.extend(node.children.iter().rev());
        }
        let reachable_set: HashSet<i32> = reachable.iter().copied().collect();
        let mut creates = Vec::new();
        let mut attrs = Vec::new();
        let mut kids = Vec::new();
        for &tag in &reachable {
            let Some(node) = self.nodes.get(&tag) else {
                continue;
            };
            if !node.kind.is_layout() {
                continue;
            }
            let Some(id) = node.taffy else { continue };
            let mounted = self.mounted.entry(tag).or_insert_with(|| {
                creates.push(OP_CREATE);
                put_i32(&mut creates, tag);
                creates.push(match node.kind {
                    Kind::Text => KIND_TEXT,
                    Kind::Scroll => KIND_SCROLL,
                    Kind::TextInput => KIND_INPUT,
                    Kind::Image => KIND_IMAGE,
                    Kind::Vector => KIND_VECTOR,
                    _ => KIND_VIEW,
                });
                Mounted {
                    frame: [f32::NAN; 4],
                    ..Mounted::default()
                }
            });
            let layout = self.tree.layout(id).map_err(|e| e.to_string())?;
            let frame = [
                layout.location.x,
                layout.location.y,
                layout.size.width,
                layout.size.height,
            ];
            if frame != mounted.frame {
                attrs.push(OP_FRAME);
                put_i32(&mut attrs, tag);
                for v in frame {
                    put_f32(&mut attrs, v);
                }
                mounted.frame = frame;
            }
            let visual = visual_of(&node.props);
            if mounted.visual.as_ref() != Some(&visual) {
                attrs.push(OP_VIEW_STYLE);
                put_i32(&mut attrs, tag);
                put_i32(&mut attrs, visual.background.unwrap_or(0));
                put_i32(&mut attrs, visual.border_color.unwrap_or(0));
                put_f32(&mut attrs, visual.border_width);
                put_f32(&mut attrs, visual.radius);
                put_f32(&mut attrs, visual.opacity);
                mounted.visual = Some(visual);
            }
            // Sent once a view has any, and whenever they change after that.
            let effects = effects_of(&node.props);
            let first_and_none = mounted.effects.is_none() && effects == Effects::default();
            if !first_and_none && mounted.effects.as_ref() != Some(&effects) {
                attrs.push(OP_EFFECTS);
                put_i32(&mut attrs, tag);
                for v in [
                    effects.shadow_x,
                    effects.shadow_y,
                    effects.shadow_blur,
                    effects.shadow_spread,
                ] {
                    put_f32(&mut attrs, v);
                }
                put_i32(&mut attrs, effects.shadow_color);
                put_f32(&mut attrs, effects.backdrop_blur);
                attrs.push(u8::from(effects.clip));
                mounted.effects = Some(effects);
            }
            if node.kind == Kind::Vector {
                if node.vector != mounted.text {
                    attrs.push(OP_VECTOR);
                    put_i32(&mut attrs, tag);
                    put_i32(&mut attrs, node.vector.len() as i32);
                    attrs.extend_from_slice(&node.vector);
                    mounted.text = node.vector.clone();
                }
            } else if node.kind == Kind::Image {
                let encoded = encode_image(&node.props);
                if encoded != mounted.text {
                    attrs.push(OP_IMAGE);
                    put_i32(&mut attrs, tag);
                    put_i32(&mut attrs, encoded.len() as i32);
                    attrs.extend_from_slice(&encoded);
                    mounted.text = encoded;
                }
            } else if node.kind == Kind::TextInput {
                let encoded = encode_input(&node.props, layout);
                if encoded != mounted.text {
                    attrs.push(OP_INPUT);
                    put_i32(&mut attrs, tag);
                    put_i32(&mut attrs, encoded.len() as i32);
                    attrs.extend_from_slice(&encoded);
                    mounted.text = encoded;
                }
            } else if node.kind == Kind::Text {
                let encoded = self.spans.get(&tag).cloned().unwrap_or_default();
                if encoded != mounted.text {
                    attrs.push(OP_TEXT);
                    put_i32(&mut attrs, tag);
                    put_i32(&mut attrs, encoded.len() as i32);
                    attrs.extend_from_slice(&encoded);
                    mounted.text = encoded;
                }
            } else {
                let layout_children: Vec<i32> = node
                    .children
                    .iter()
                    .copied()
                    .filter(|c| {
                        self.nodes
                            .get(c)
                            .map(|n| n.kind.is_layout())
                            .unwrap_or(false)
                    })
                    .collect();
                if layout_children != mounted.children {
                    kids.push(OP_CHILDREN);
                    put_i32(&mut kids, tag);
                    put_i32(&mut kids, layout_children.len() as i32);
                    for c in &layout_children {
                        put_i32(&mut kids, *c);
                    }
                    mounted.children = layout_children;
                }
            }
        }
        out.extend_from_slice(&creates);
        out.extend_from_slice(&attrs);
        out.extend_from_slice(&kids);
        if self.mounted_root != Some(root) {
            out.push(OP_ROOT);
            put_i32(out, root);
            self.mounted_root = Some(root);
        }
        // Drop what is no longer reachable: the views, the taffy nodes, the tags.
        let gone: Vec<i32> = self
            .nodes
            .keys()
            .copied()
            .filter(|t| !reachable_set.contains(t))
            .collect();
        for tag in gone {
            if let Some(node) = self.nodes.remove(&tag) {
                if let Some(id) = node.taffy {
                    let _ = self.tree.remove(id);
                }
            }
            if self.mounted.remove(&tag).is_some() {
                out.push(OP_DELETE);
                put_i32(out, tag);
            }
            self.parent.remove(&tag);
            self.spans.remove(&tag);
            gesture::with(|g| g.remove(tag));
            motion::with(|m| m.forget_view(tag));
            info.deleted.push(tag);
        }
        info.nodes = self.nodes.len();
        info.diff_us = t2.elapsed().as_micros();
        Ok(info)
    }
}

// ---------------------------------------------------------------- C ABI

thread_local! {
    static HOST: RefCell<Host> = RefCell::new(Host::default());
}

#[repr(C)]
pub struct OrbitBuf {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl OrbitBuf {
    fn from_vec(mut v: Vec<u8>) -> OrbitBuf {
        let buf = OrbitBuf {
            ptr: v.as_mut_ptr(),
            len: v.len(),
            cap: v.capacity(),
        };
        std::mem::forget(v);
        buf
    }
}

/// # Safety
/// `buf` must come from this library and be freed once.
#[no_mangle]
pub unsafe extern "C" fn orbit_buf_free(buf: OrbitBuf) {
    if !buf.ptr.is_null() {
        drop(Vec::from_raw_parts(buf.ptr, buf.len, buf.cap));
    }
}

#[no_mangle]
pub extern "C" fn orbit_set_measure(measure: MeasureFn) {
    HOST.with(|h| h.borrow_mut().set_measure(measure));
}

#[no_mangle]
pub extern "C" fn orbit_set_viewport(width: f32, height: f32) {
    HOST.with(|h| h.borrow_mut().set_viewport(width, height));
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_owned())
}

fn info_json(info: &CommitInfo, ops_bytes: usize) -> String {
    serde_json::json!({
        "deleted": info.deleted,
        "parseUs": info.parse_us as u64,
        "layoutUs": info.layout_us as u64,
        "diffUs": info.diff_us as u64,
        "measures": info.measures,
        "nodes": info.nodes,
        "opsBytes": ops_bytes,
    })
    .to_string()
}

/// A touch from the UI thread (see `gesture::Gestures::touch`); `out`
/// receives the commands.
///
/// # Safety
/// `out` must be valid.
#[no_mangle]
pub unsafe extern "C" fn orbit_touch(
    action: u8,
    x: f32,
    y: f32,
    now_ns: i64,
    hit: i32,
    out: *mut OrbitBuf,
) {
    let mut commands = Vec::new();
    gesture::with(|g| g.touch(action, x, y, now_ns, hit, &mut commands));
    *out = OrbitBuf::from_vec(commands);
}

/// Every vsync on the UI thread: long presses and delayed feedback.
///
/// # Safety
/// `out` must be valid.
#[no_mangle]
pub unsafe extern "C" fn orbit_gesture_tick(now_ns: i64, out: *mut OrbitBuf) {
    let mut commands = Vec::new();
    gesture::with(|g| g.tick(now_ns, &mut commands));
    *out = OrbitBuf::from_vec(commands);
}

/// The frames of a JSON array of tags, as a JSON array of `[x, y, w, h]` or
/// null (see `Host::frames`). Returns 0, or 1 with `{"error": …}`.
///
/// # Safety
/// `tags` must point to `len` readable bytes; `out` must be valid.
#[no_mangle]
pub unsafe extern "C" fn orbit_layout(tags: *const u8, len: usize, out: *mut OrbitBuf) -> i32 {
    let input = std::slice::from_raw_parts(tags, len);
    let (code, json) = match serde_json::from_slice::<Vec<i32>>(input) {
        Ok(tags) => (
            0,
            serde_json::to_string(&HOST.with(|h| h.borrow().frames(&tags)))
                .unwrap_or_else(|_| "[]".to_owned()),
        ),
        Err(e) => (1, serde_json::json!({ "error": e.to_string() }).to_string()),
    };
    *out = OrbitBuf::from_vec(json.into_bytes());
    code
}

/// Commit a JSON batch. `mount_ops` receives the binary mount operations,
/// `info` a JSON object (or `{"error": …}`). Returns 0 on success.
///
/// # Safety
/// `ops` must point to `len` readable bytes; both out-pointers must be valid.
#[no_mangle]
pub unsafe extern "C" fn orbit_commit(
    ops: *const u8,
    len: usize,
    mount_ops: *mut OrbitBuf,
    info: *mut OrbitBuf,
) -> i32 {
    let input = std::slice::from_raw_parts(ops, len);
    let result = std::panic::catch_unwind(|| {
        HOST.with(|h| {
            let mut out = Vec::new();
            let info = h.borrow_mut().commit(input, &mut out)?;
            Ok::<_, String>((out, info))
        })
    });
    let (code, ops_out, info_out) = match result {
        Ok(Ok((out, i))) => {
            let json = info_json(&i, out.len());
            (0, out, json)
        }
        Ok(Err(e)) => (1, Vec::new(), serde_json::json!({ "error": e }).to_string()),
        Err(p) => (
            2,
            Vec::new(),
            serde_json::json!({ "error": panic_message(p) }).to_string(),
        ),
    };
    *mount_ops = OrbitBuf::from_vec(ops_out);
    *info = OrbitBuf::from_vec(info_out.into_bytes());
    code
}

#[no_mangle]
pub extern "C" fn orbit_motion_value(tag: i32, initial: f64) {
    motion::with(|m| m.value(tag, initial));
}

/// # Safety
/// `from` and `to` must point to `len` readable f64s.
#[no_mangle]
pub unsafe extern "C" fn orbit_motion_interpolate(
    tag: i32,
    input: i32,
    from: *const f64,
    to: *const f64,
    len: usize,
) {
    let from = std::slice::from_raw_parts(from, len).to_vec();
    let to = std::slice::from_raw_parts(to, len).to_vec();
    motion::with(|m| m.interpolation(tag, input, from, to));
}

#[no_mangle]
pub extern "C" fn orbit_motion_set(tag: i32, value: f64) {
    motion::with(|m| m.set(tag, value));
}

#[no_mangle]
pub extern "C" fn orbit_motion_stop(tag: i32) {
    motion::with(|m| m.stop(tag));
}

/// # Safety
/// `frames` must point to `len` readable f64s.
#[no_mangle]
pub unsafe extern "C" fn orbit_motion_frames(
    tag: i32,
    frames: *const f64,
    len: usize,
    to: f64,
    looping: bool,
) {
    let frames = std::slice::from_raw_parts(frames, len).to_vec();
    motion::with(|m| m.frames(tag, frames, to, looping));
}

#[no_mangle]
pub extern "C" fn orbit_motion_spring(tag: i32, to: f64, stiffness: f64, damping: f64, mass: f64) {
    motion::with(|m| m.spring(tag, to, stiffness, damping, mass));
}

#[no_mangle]
pub extern "C" fn orbit_motion_dispose(tag: i32) {
    motion::with(|m| m.dispose(tag));
}

#[no_mangle]
pub extern "C" fn orbit_motion_bind(view: i32, prop: u8, node: i32) {
    motion::with(|m| m.bind(view, prop, node));
}

#[no_mangle]
pub extern "C" fn orbit_motion_bind_scroll(scroll_view: i32, value: i32) {
    motion::with(|m| m.bind_scroll(scroll_view, value));
}

/// Advance every animation to `now_ns` (UI thread). `scroll_tags`/`scroll_y`
/// carry `count` scroll offsets in dp. `out` receives 9-byte records
/// (i32 view, u8 prop, f32 value). Returns 1 while an animation is running.
///
/// # Safety
/// The input pointers must hold `count` items; `out` must be valid.
#[no_mangle]
pub unsafe extern "C" fn orbit_motion_tick(
    now_ns: i64,
    scroll_tags: *const i32,
    scroll_y: *const f32,
    count: usize,
    out: *mut OrbitBuf,
) -> i32 {
    let tags = if count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(scroll_tags, count)
    };
    let ys = if count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(scroll_y, count)
    };
    let scrolls: Vec<(i32, f32)> = tags.iter().copied().zip(ys.iter().copied()).collect();
    let mut buf = Vec::new();
    let active = motion::with(|m| m.tick(now_ns, &scrolls, &mut buf));
    *out = OrbitBuf::from_vec(buf);
    i32::from(active)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The op codes of a mount buffer, in order.
    fn codes(buf: &[u8]) -> Vec<u8> {
        let i32_at =
            |i: usize| i32::from_le_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        let mut out = Vec::new();
        let mut i = 0;
        while i < buf.len() {
            let code = buf[i];
            out.push(code);
            i += 5; // code + tag
            i += match code {
                OP_CREATE => 1,
                OP_DELETE | OP_ROOT => 0,
                OP_CHILDREN => 4 + 4 * i32_at(i),
                OP_FRAME => 16,
                OP_VIEW_STYLE => 20,
                OP_EFFECTS => 25,
                OP_TEXT | OP_INPUT | OP_IMAGE | OP_VECTOR => 4 + i32_at(i),
                _ => panic!("unknown op {code}"),
            };
        }
        out
    }

    fn commit(host: &mut Host, ops: &str) -> (Vec<u8>, CommitInfo) {
        let mut out = Vec::new();
        let info = host.commit(ops.as_bytes(), &mut out).expect("commit");
        (out, info)
    }

    #[test]
    fn mounts_lays_out_and_patches_only_what_changed() {
        let mut host = Host::default();
        host.set_viewport(300.0, 600.0);
        let (first, _) = commit(
            &mut host,
            r#"[["c",1,"RCTView",{"padding":10}],["c",3,"RCTView",{"flexDirection":"row","height":20,"backgroundColor":-16776961}],
                ["c",5,"RCTText",{"fontSize":12}],["c",7,"RCTRawText",{"text":"hello"}],
                ["k",5,[7]],["k",3,[5]],["k",1,[3]],["r",1]]"#,
        );
        let first = codes(&first);
        assert_eq!(first.iter().filter(|c| **c == OP_CREATE).count(), 3);
        assert_eq!(first.last(), Some(&OP_ROOT));
        let row = host.tree.layout(host.nodes[&3].taffy.unwrap()).unwrap();
        assert_eq!(
            (
                row.location.x,
                row.location.y,
                row.size.width,
                row.size.height
            ),
            (10.0, 10.0, 280.0, 20.0)
        );

        // Only the raw text changes: one TEXT op for its Text node (and its new frame).
        let (second, info) = commit(&mut host, r#"[["u",7,{"text":"hello world"}]]"#);
        assert_eq!(codes(&second), vec![OP_FRAME, OP_TEXT]);
        assert!(info.deleted.is_empty());

        // Nothing changed: nothing to mount.
        let (third, _) = commit(&mut host, "[]");
        assert!(third.is_empty());
    }

    #[test]
    fn a_text_field_is_a_measured_leaf_with_its_props_and_padding() {
        let mut host = Host::default();
        host.set_viewport(300.0, 600.0);
        let (first, _) = commit(
            &mut host,
            r#"[["c",1,"RCTView",{"flexDirection":"row","alignItems":"center"}],
                ["c",3,"OrbitTextInput",{"padding":12,"fontSize":16,"placeholder":"Message","text":"","textVersion":0}],
                ["k",1,[3]],["r",1]]"#,
        );
        assert!(codes(&first).contains(&OP_INPUT));
        let field = host.tree.layout(host.nodes[&3].taffy.unwrap()).unwrap();
        // No width from its box in a row: the default; height: one line + padding.
        assert_eq!(field.size.width, DEFAULT_INPUT_WIDTH + 24.0);
        assert_eq!(field.size.height, 16.0 + 24.0);
        let json = String::from_utf8_lossy(&first);
        assert!(
            json.contains(r#""padding":[12.0,12.0,12.0,12.0]"#),
            "{json}"
        );
        assert!(json.contains(r#""placeholder":"Message""#), "{json}");

        // The app clears the field: one INPUT op, nothing else.
        let (second, _) = commit(&mut host, r#"[["u",3,{"text":"","textVersion":1}]]"#);
        assert_eq!(codes(&second), vec![OP_INPUT]);
    }

    #[test]
    fn a_field_sized_by_its_content_grows_with_its_lines() {
        let mut host = Host::default();
        host.set_viewport(300.0, 600.0);
        commit(
            &mut host,
            r#"[["c",1,"RCTView",{"alignItems":"flex-start"}],
                ["c",3,"OrbitTextInput",{"multiline":true,"rows":1,"fieldSizing":"content","maxHeight":40,"fontSize":16}],
                ["k",1,[3]],["r",1]]"#,
        );
        let height = |host: &Host| {
            host.tree
                .layout(host.nodes[&3].taffy.unwrap())
                .unwrap()
                .size
                .height
        };
        assert_eq!(height(&host), 16.0);
        // Desktop fallback measure: 16 dp a line, whatever the line count — so
        // what this checks is that the measured text changes, and max-h caps it.
        commit(&mut host, r#"[["u",3,{"measureText":"un\ndeux"}]]"#);
        assert!(host.spans[&3].ends_with(b"un\ndeux"));
        commit(&mut host, r#"[["u",3,{"maxHeight":8}]]"#);
        assert_eq!(height(&host), 8.0);
    }

    #[test]
    fn a_vector_is_a_leaf_sent_with_its_paths_once_per_change() {
        let mut host = Host::default();
        host.set_viewport(300.0, 600.0);
        let icon = r##"{"color":-16777216,"root":{"t":"svg","a":{"viewBox":"0 0 24 24","fill":"none","stroke":"currentColor"},"c":[{"t":"path","a":{"d":"M5 12h14"}}]}}"##;
        let (first, _) = commit(
            &mut host,
            &format!(
                r#"[["c",1,"RCTView",{{}}],["c",3,"OrbitVector",{{"width":24,"height":24,"vector":{icon}}}],["k",1,[3]],["r",1]]"#
            ),
        );
        let size = host
            .tree
            .layout(host.nodes[&3].taffy.unwrap())
            .unwrap()
            .size;
        assert_eq!((size.width, size.height), (24.0, 24.0));
        assert_eq!(codes(&first).iter().filter(|c| **c == OP_VECTOR).count(), 1);
        let create = first
            .windows(6)
            .position(|w| w[0] == OP_CREATE && w[1..5] == 3i32.to_le_bytes())
            .unwrap();
        assert_eq!(first[create + 5], KIND_VECTOR);

        // A resize alone sends no paths; a new drawing does.
        let (second, _) = commit(&mut host, r#"[["u",3,{"width":32,"height":32}]]"#);
        assert!(!codes(&second).contains(&OP_VECTOR));
        let red = icon.replace("-16777216", "-65536");
        let (third, _) = commit(&mut host, &format!(r#"[["u",3,{{"vector":{red}}}]]"#));
        assert_eq!(codes(&third), vec![OP_VECTOR]);

        let broken = r#"[["u",3,{"vector":{"root":{"t":"svg","a":{"viewBox":"0 0 1 1"},"c":[{"t":"path","a":{"d":"M0 0 Q"}}]}}}]]"#;
        assert!(host.commit(broken.as_bytes(), &mut Vec::new()).is_err());
    }

    #[test]
    fn an_image_is_a_leaf_sized_by_its_style_and_sent_with_its_source() {
        let mut host = Host::default();
        host.set_viewport(300.0, 600.0);
        let (first, info) = commit(
            &mut host,
            r#"[["c",1,"RCTView",{}],
                ["c",3,"OrbitImage",{"width":"100%","aspectRatio":1.5,"borderRadius":8,"src":"https://cdn.example.com/a.jpg","alt":"Plage","objectFit":"cover"}],
                ["c",5,"OrbitImage",{"src":"asset:logo.png"}],
                ["k",1,[3,5]],["r",1]]"#,
        );
        assert_eq!(info.measures, 0, "an image is never measured");
        let size = |tag: i32| {
            host.tree
                .layout(host.nodes[&tag].taffy.unwrap())
                .unwrap()
                .size
        };
        assert_eq!((size(3).width, size(3).height), (300.0, 200.0));
        // Unsized, it gets no height (stretched across the column, as any
        // item): its box does not wait for the decode to learn a size.
        assert_eq!((size(5).width, size(5).height), (300.0, 0.0));
        assert_eq!(codes(&first).iter().filter(|c| **c == OP_IMAGE).count(), 2);
        let json = String::from_utf8_lossy(&first);
        assert!(
            json.contains(r#"{"alt":"Plage","fit":"cover","src":"https://cdn.example.com/a.jpg"}"#),
            "{json}"
        );
        assert!(
            json.contains(r#""fit":"fill""#),
            "CSS's default fit: {json}"
        );

        // A new source: one IMAGE op; a resize alone: only the frame.
        let (second, _) = commit(&mut host, r#"[["u",5,{"src":"bytes:2"}]]"#);
        assert_eq!(codes(&second), vec![OP_IMAGE]);
        let (third, _) = commit(&mut host, r#"[["u",5,{"width":40,"height":40}]]"#);
        assert_eq!(codes(&third), vec![OP_FRAME]);
    }

    #[test]
    fn frames_are_in_the_roots_coordinates_and_hidden_nodes_take_no_room() {
        let mut host = Host::default();
        host.set_viewport(300.0, 600.0);
        commit(
            &mut host,
            r#"[["c",1,"RCTView",{"padding":10}],
                ["c",3,"RCTView",{"height":0,"display":"none"}],
                ["c",5,"RCTView",{"paddingTop":4}],
                ["c",7,"RCTView",{"height":30}],
                ["c",9,"RCTView",{"height":40}],
                ["k",5,[7,9]],["k",1,[3,5]],["r",1]]"#,
        );
        let frames = host.frames(&[3, 7, 9, 42]);
        assert_eq!(frames[0].map(|f| f[3]), Some(0.0));
        // 10 of the root's padding, 4 of the container's: the hidden spacer takes none.
        assert_eq!(frames[1], Some([10.0, 14.0, 280.0, 30.0]));
        assert_eq!(frames[2], Some([10.0, 44.0, 280.0, 40.0]));
        assert_eq!(frames[3], None);
    }

    #[test]
    fn effects_are_sent_when_a_view_has_any_and_when_they_change() {
        let mut host = Host::default();
        let (first, _) = commit(
            &mut host,
            r#"[["c",1,"RCTView",{}],
                ["c",3,"RCTView",{"height":40,"shadowY":10,"shadowBlur":15,"shadowSpread":-3,"shadowColor":436207616}],
                ["c",5,"RCTView",{"height":40,"backdropBlur":16,"overflow":"hidden"}],
                ["k",1,[3,5]],["r",1]]"#,
        );
        // Two views have effects; the root has none and gets no op.
        assert_eq!(
            codes(&first).iter().filter(|c| **c == OP_EFFECTS).count(),
            2
        );
        let at = first
            .windows(5)
            .position(|w| w[0] == OP_EFFECTS && w[1..5] == 3i32.to_le_bytes())
            .expect("the shadowed view's effects");
        let f = |i: usize| {
            f32::from_le_bytes(first[at + 5 + 4 * i..at + 9 + 4 * i].try_into().unwrap())
        };
        assert_eq!((f(0), f(1), f(2), f(3)), (0.0, 10.0, 15.0, -3.0));
        // Unchanged: nothing; the shadow removed: one op, back to none.
        let (second, _) = commit(&mut host, r#"[["u",5,{"height":50}]]"#);
        assert!(!codes(&second).contains(&OP_EFFECTS));
        let (third, _) = commit(
            &mut host,
            r#"[["u",3,{"shadowY":null,"shadowBlur":null,"shadowSpread":null,"shadowColor":null}]]"#,
        );
        assert_eq!(codes(&third), vec![OP_EFFECTS]);
    }

    #[test]
    fn a_commit_keeps_the_gesture_tree_the_ui_thread_recognizes_on() {
        // Tags of their own: the gesture tree is shared by every host in the process.
        let mut host = Host::default();
        commit(
            &mut host,
            r#"[["c",901,"RCTScrollView",{}],["c",903,"RCTView",{}],
                ["c",905,"RCTView",{"height":40,"gestures":1}],["c",907,"RCTText",{}],
                ["k",905,[907]],["k",903,[905]],["k",901,[903]],["r",901]]"#,
        );
        let tap = |host_tag: i32| {
            let mut out = Vec::new();
            gesture::with(|g| {
                g.touch(gesture::DOWN, 5.0, 5.0, 0, host_tag, &mut out);
                g.touch(gesture::UP, 5.0, 5.0, 300_000_000, host_tag, &mut out);
            });
            out
        };
        // A tap on the row's text presses the row (in a scroll view: the
        // feedback flashes on release, then the event).
        let out = tap(907);
        assert_eq!(out.first(), Some(&gesture::CMD_PRESSED));
        assert_eq!(out[1..5], 905i32.to_le_bytes());
        assert!(out.windows(8).any(|w| w == b"topPress"));
        // Its handler gone: nothing.
        commit(&mut host, r#"[["u",905,{"gestures":0}]]"#);
        assert!(tap(907).is_empty());
    }

    #[test]
    fn drops_nodes_that_left_the_tree() {
        let mut host = Host::default();
        commit(
            &mut host,
            r#"[["c",1,"RCTView",{}],["c",3,"RCTView",{}],["k",1,[3]],["r",1]]"#,
        );
        let (out, info) = commit(&mut host, r#"[["k",1,[]]]"#);
        assert_eq!(info.deleted, vec![3]);
        assert_eq!(codes(&out), vec![OP_CHILDREN, OP_DELETE]);
    }
}
