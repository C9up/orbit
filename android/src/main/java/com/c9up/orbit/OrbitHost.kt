package com.c9up.orbit

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The platform side of orbit's Rust host. orbit-host (Rust) owns the
 * tree, the layout and the diff; this object only applies its mount operations
 * to real Android views on the UI thread, measures text for its layout, and
 * hands touches back to JS. Op codes match rust/orbit-host/src/lib.rs.
 */
object OrbitHost {
  private const val OP_CREATE = 1
  private const val OP_DELETE = 2
  private const val OP_CHILDREN = 3
  private const val OP_FRAME = 4
  private const val OP_VIEW_STYLE = 5
  private const val OP_TEXT = 6
  private const val OP_ROOT = 7
  private const val OP_INPUT = 8
  private const val OP_IMAGE = 9
  private const val OP_VECTOR = 11
  private const val OP_EFFECTS = 10

  @JvmStatic external fun nativeInit()

  @JvmStatic external fun nativeDispatch(tag: Int, type: String, x: Float, y: Float)

  @JvmStatic external fun nativeDispatchText(tag: Int, type: String, text: String)

  @JvmStatic external fun nativeViewport(width: Float, height: Float)

  /** A touch for orbit-host's gesture recognizer (action 0 down, 1 move, 2 up, 3 cancel; dp). */
  @JvmStatic external fun nativeTouch(action: Int, x: Float, y: Float, nowNs: Long, hit: Int): ByteArray

  @JvmStatic external fun nativeGestureTick(nowNs: Long): ByteArray

  fun viewOf(tag: Int): View? = views[tag]

  /** The safe area changed (bars, cutout, keyboard): JS lays out again, now or once it listens. */
  fun reportViewport(width: Float, height: Float) = nativeViewport(width, height)

  @JvmStatic external fun nativeTick(nowNs: Long, scrollTags: IntArray, scrollY: FloatArray): ByteArray

  private const val PROP_OPACITY = 0
  private const val PROP_TRANSLATE_X = 1
  private const val PROP_TRANSLATE_Y = 2
  private const val PROP_SCALE = 3
  private const val PROP_VISIBLE = 4

  /** Every vsync: orbit-host advances its animations; no JS involved. */
  private val frame = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      val scrolls = views.values.filterIsInstance<OrbitScroll>()
      val tags = IntArray(scrolls.size) { scrolls[it].tag as Int }
      val ys = FloatArray(scrolls.size) { scrolls[it].scrollY / density }
      root?.let { OrbitPress.apply(it, nativeGestureTick(frameTimeNanos)) }
      val out = nativeTick(frameTimeNanos, tags, ys)
      val buf = ByteBuffer.wrap(out, 1, out.size - 1).order(ByteOrder.LITTLE_ENDIAN)
      if (buf.remaining() >= 9) OrbitEffects.invalidateBackdrops()
      while (buf.remaining() >= 9) {
        val tag = buf.int
        val prop = buf.get().toInt()
        val value = buf.float
        val view = views[tag]
        if (view == null) {
          // Bound right after a commit whose views are not mounted yet: the
          // host sends a value once, so keep it for the view's creation.
          early.getOrPut(tag) { HashMap() }[prop] = value
          continue
        }
        applyMotion(view, prop, value)
      }
      Choreographer.getInstance().postFrameCallback(this)
    }
  }

  /** Motion values that reached a view before its creation, by tag then prop. */
  private val early = HashMap<Int, HashMap<Int, Float>>()

  private fun applyMotion(view: View, prop: Int, value: Float) {
    when (prop) {
      PROP_OPACITY -> view.alpha = value
      PROP_TRANSLATE_X -> view.translationX = value * density
      PROP_TRANSLATE_Y -> view.translationY = value * density
      PROP_SCALE -> { view.scaleX = value; view.scaleY = value }
      // Invisible keeps the layout (and a scroll view's offset) but is not
      // drawn and takes no touch: a covered screen.
      PROP_VISIBLE -> view.visibility = if (value > 0.5f) View.VISIBLE else View.INVISIBLE
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private val views = HashMap<Int, View>()
  private var root: OrbitRoot? = null
  var density = 1f
    private set

  /** `animate`: tick animations into views on vsync (view host); the self-drawn host ticks them while drawing. */
  fun attach(activity: Activity, animate: Boolean = true): View {
    density = activity.resources.displayMetrics.density
    // The C++ side lives in libappmodules; make sure it is loaded before binding.
    com.facebook.soloader.SoLoader.loadLibrary("appmodules")
    nativeInit()
    val view = OrbitRoot(activity)
    root = view
    if (animate) Choreographer.getInstance().postFrameCallback(frame)
    return view
  }

  /** Called by the C++ module on the JS thread; applied on the UI thread. */
  @JvmStatic
  fun apply(ops: ByteArray) {
    main.post {
      applyNow(ops)
      OrbitEffects.invalidateBackdrops()
    }
  }

  /** Called by the C++ module on the JS thread: scroll a scroll view by `by` dp, or to its end. */
  @JvmStatic
  fun scroll(tag: Int, by: Float, toEnd: Boolean) {
    main.post {
      val view = views[tag] as? OrbitScroll ?: return@post
      if (toEnd) {
        val content = view.getChildAt(0)
        view.scrollTo(0, maxOf(0, (content?.bottom ?: 0) - view.height))
      } else {
        view.scrollBy(0, (by * density).toInt())
      }
    }
  }

  /** Called by the C++ module on the JS thread: an image node's bytes, kept in memory. */
  @JvmStatic
  fun imageBytes(tag: Int, bytes: ByteArray) = OrbitImages.put(tag, bytes)

  /** Text size in dp, packed as two float bit patterns (width high, height low). */
  @JvmStatic
  fun measureText(spans: ByteArray, maxWidth: Float): Long {
    val text = OrbitText.decode(spans, density)
    val maxPx = if (maxWidth.isInfinite() || maxWidth > 1e6f) Int.MAX_VALUE / 2 else (maxWidth * density).toInt()
    val (w, h) = text.measure(maxPx)
    // The width in whole dp, rounded up: the layout rounds frames to whole dp,
    // and a text even a fraction narrower than it measured wraps and loses its
    // last word. The height stays exact — rounded up, every line of a
    // 19.25 dp line height grew by most of a dp against the web.
    val wBits = java.lang.Float.floatToRawIntBits(kotlin.math.ceil(w / density)).toLong()
    val hBits = java.lang.Float.floatToRawIntBits(h / density).toLong()
    return (wBits shl 32) or (hBits and 0xffffffffL)
  }

  private fun applyNow(ops: ByteArray) {
    val root = root ?: return
    val buf = ByteBuffer.wrap(ops).order(ByteOrder.LITTLE_ENDIAN)
    val context = root.context
    while (buf.hasRemaining()) {
      val code = buf.get().toInt()
      val tag = buf.int
      when (code) {
        OP_CREATE -> {
          val view: View = when (buf.get().toInt()) {
            1 -> OrbitTextView(context)
            2 -> OrbitScroll(context)
            3 -> OrbitInput(context)
            4 -> OrbitImage(context)
            5 -> OrbitVector(context)
            else -> OrbitBox(context)
          }
          view.tag = tag
          views[tag] = view
          early.remove(tag)?.forEach { (prop, value) -> applyMotion(view, prop, value) }
        }
        OP_DELETE -> {
          early.remove(tag)
          views.remove(tag)?.let { (it.parent as? ViewGroup)?.removeView(it) }
          OrbitImages.release(tag)
        }
        OP_CHILDREN -> {
          val parent = views[tag] as? ViewGroup
          val count = buf.int
          val wanted = ArrayList<View>(count)
          repeat(count) { views[buf.int]?.let(wanted::add) }
          if (parent != null) setChildren(parent, wanted)
        }
        OP_FRAME -> {
          val x = buf.float; val y = buf.float; val w = buf.float; val h = buf.float
          (views[tag] as? Framed)?.setFrame(x * density, y * density, w * density, h * density)
        }
        OP_VIEW_STYLE -> {
          val background = buf.int; val borderColor = buf.int
          val borderWidth = buf.float; val radius = buf.float; val opacity = buf.float
          (views[tag] as? Framed)?.setLook(background, borderColor, borderWidth * density, radius * density, opacity)
        }
        OP_TEXT -> {
          val bytes = ByteArray(buf.int)
          buf.get(bytes)
          (views[tag] as? OrbitTextView)?.setText(OrbitText.decode(bytes, density))
        }
        OP_INPUT -> {
          val bytes = ByteArray(buf.int)
          buf.get(bytes)
          (views[tag] as? OrbitInput)?.apply(String(bytes, Charsets.UTF_8), density)
        }
        OP_IMAGE -> {
          val bytes = ByteArray(buf.int)
          buf.get(bytes)
          (views[tag] as? OrbitImage)?.apply(String(bytes, Charsets.UTF_8))
        }
        OP_VECTOR -> {
          val bytes = ByteArray(buf.int)
          buf.get(bytes)
          (views[tag] as? OrbitVector)?.apply(bytes)
        }
        OP_EFFECTS -> {
          val dx = buf.float; val dy = buf.float; val blur = buf.float; val spread = buf.float
          val color = buf.int; val backdrop = buf.float; val clip = buf.get().toInt() != 0
          views[tag]?.let { view ->
            val shadow = if (color ushr 24 == 0) null else Shadow(dx * density, dy * density, blur * density, spread * density, color)
            OrbitEffects.apply(view, shadow, backdrop * density, clip)
          }
        }
        OP_ROOT -> views[tag]?.let { setChildren(root.content, listOf(it)) }
        else -> throw IllegalStateException("unknown op $code")
      }
    }
  }

  /** Make `parent`'s children exactly `wanted`, moving only what is out of place. */
  private fun setChildren(parent: ViewGroup, wanted: List<View>) {
    for ((i, child) in wanted.withIndex()) {
      if (parent.getChildAt(i) === child) continue
      (child.parent as? ViewGroup)?.removeView(child)
      parent.addView(child, i)
    }
    while (parent.childCount > wanted.size) parent.removeViewAt(parent.childCount - 1)
  }

  /** The deepest host view under (x, y) in root pixels, as a tag. */
  fun hitTest(group: ViewGroup, x: Float, y: Float): Int? {
    for (i in group.childCount - 1 downTo 0) {
      val child = group.getChildAt(i)
      val left = child.left + child.translationX
      val top = child.top + child.translationY
      if (child.visibility == View.VISIBLE && x >= left && x < left + child.width && y >= top && y < top + child.height) {
        val inner = (child as? ViewGroup)?.let { hitTest(it, x - left + child.scrollX, y - top + child.scrollY) }
        return inner ?: (child.tag as? Int)
      }
    }
    return null
  }
}
