package com.c9up.orbit

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
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

  @JvmStatic external fun nativeInit()

  @JvmStatic external fun nativeDispatch(tag: Int, type: String, x: Float, y: Float)

  @JvmStatic external fun nativeDispatchText(tag: Int, type: String, text: String)

  @JvmStatic external fun nativeViewport(width: Float, height: Float)

  /** The safe area changed (bars, cutout, keyboard): JS lays out again, now or once it listens. */
  fun reportViewport(width: Float, height: Float) = nativeViewport(width, height)

  @JvmStatic external fun nativeTick(nowNs: Long, scrollTags: IntArray, scrollY: FloatArray): ByteArray

  private const val PROP_OPACITY = 0
  private const val PROP_TRANSLATE_X = 1
  private const val PROP_TRANSLATE_Y = 2
  private const val PROP_SCALE = 3

  /** Every vsync: orbit-host advances its animations; no JS involved. */
  private val frame = object : Choreographer.FrameCallback {
    override fun doFrame(frameTimeNanos: Long) {
      val scrolls = views.values.filterIsInstance<OrbitScroll>()
      val tags = IntArray(scrolls.size) { scrolls[it].tag as Int }
      val ys = FloatArray(scrolls.size) { scrolls[it].scrollY / density }
      val out = nativeTick(frameTimeNanos, tags, ys)
      val buf = ByteBuffer.wrap(out, 1, out.size - 1).order(ByteOrder.LITTLE_ENDIAN)
      while (buf.remaining() >= 9) {
        val view = views[buf.int]
        val prop = buf.get().toInt()
        val value = buf.float
        if (view == null) continue
        when (prop) {
          PROP_OPACITY -> view.alpha = value
          PROP_TRANSLATE_X -> view.translationX = value * density
          PROP_TRANSLATE_Y -> view.translationY = value * density
          PROP_SCALE -> { view.scaleX = value; view.scaleY = value }
        }
      }
      Choreographer.getInstance().postFrameCallback(this)
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
    val queued = SystemClock.elapsedRealtimeNanos()
    main.post {
      val start = SystemClock.elapsedRealtimeNanos()
      applyNow(ops)
      val end = SystemClock.elapsedRealtimeNanos()
      Log.i("ORBIT", "APPLY bytes=${ops.size} waitMs=${(start - queued) / 1e6} applyMs=${(end - start) / 1e6}")
    }
  }

  /** Text size in dp, packed as two float bit patterns (width high, height low). */
  @JvmStatic
  fun measureText(spans: ByteArray, maxWidth: Float): Long {
    val text = OrbitText.decode(spans, density)
    val maxPx = if (maxWidth.isInfinite() || maxWidth > 1e6f) Int.MAX_VALUE / 2 else (maxWidth * density).toInt()
    val (w, h) = text.measure(maxPx)
    // Whole dp, rounded up: the layout rounds frames to whole dp, and a text
    // even a fraction narrower than it measured wraps and loses its last word.
    val wBits = java.lang.Float.floatToRawIntBits(kotlin.math.ceil(w / density)).toLong()
    val hBits = java.lang.Float.floatToRawIntBits(kotlin.math.ceil(h / density)).toLong()
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
            else -> OrbitBox(context)
          }
          view.tag = tag
          views[tag] = view
        }
        OP_DELETE -> views.remove(tag)?.let { (it.parent as? ViewGroup)?.removeView(it) }
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
      if (x >= child.left && x < child.right && y >= child.top && y < child.bottom) {
        val inner = (child as? ViewGroup)?.let { hitTest(it, x - child.left + child.scrollX, y - child.top + child.scrollY) }
        return inner ?: (child.tag as? Int)
      }
    }
    return null
  }
}
