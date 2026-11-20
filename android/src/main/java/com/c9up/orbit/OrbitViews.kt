package com.c9up.orbit

import android.content.Context
import android.graphics.Canvas
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.ceil

/** A host view whose frame and look come from orbit-host, not from Android layout. */
interface Framed {
  fun setFrame(x: Float, y: Float, w: Float, h: Float)
  fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float)
}

fun View.applyFrame(frame: FloatArray) {
  layout(frame[0].toInt(), frame[1].toInt(), (frame[0] + frame[2]).toInt(), (frame[1] + frame[3]).toInt())
}

fun View.applyLook(fill: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) {
  background = if (fill == 0 && borderWidth == 0f) null else GradientDrawable().apply {
    setColor(fill)
    cornerRadius = radius
    if (borderWidth > 0f) setStroke(ceil(borderWidth).toInt(), borderColor)
  }
  alpha = opacity
}

fun frameOf(view: View): FloatArray? =
  (view as? OrbitBox)?.frame ?: (view as? OrbitTextView)?.frame ?: (view as? OrbitScroll)?.frame

/** Native scrolling: the content child's frame (from orbit-host) sets the range. */
class OrbitScroll(context: Context) : ScrollView(context), Framed {
  val frame = FloatArray(4)

  init {
    isVerticalScrollBarEnabled = false
    overScrollMode = OVER_SCROLL_NEVER
  }

  override fun setFrame(x: Float, y: Float, w: Float, h: Float) {
    frame[0] = x; frame[1] = y; frame[2] = w; frame[3] = h
    applyFrame(frame)
  }

  override fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) =
    applyLook(background, borderColor, borderWidth, radius, opacity)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(frame[2].toInt(), frame[3].toInt())
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    for (i in 0 until childCount) {
      val child = getChildAt(i)
      frameOf(child)?.let { child.applyFrame(it) }
    }
  }
}

open class OrbitBox(context: Context) : ViewGroup(context), Framed {
  val frame = FloatArray(4)

  override fun setFrame(x: Float, y: Float, w: Float, h: Float) {
    frame[0] = x; frame[1] = y; frame[2] = w; frame[3] = h
    applyFrame(frame)
  }

  override fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) =
    applyLook(background, borderColor, borderWidth, radius, opacity)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(frame[2].toInt(), frame[3].toInt())
  }

  // Children keep the frames orbit-host gave them.
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    for (i in 0 until childCount) {
      val child = getChildAt(i)
      val f = frameOf(child) ?: continue
      child.applyFrame(f)
    }
  }
}

/** The surface root: fills the activity and turns touches into JS events. */
class OrbitRoot(context: Context) : OrbitBox(context) {
  private var target: Int? = null

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    report(event)
    super.dispatchTouchEvent(event)
    return true
  }

  private fun report(event: MotionEvent) {
    val d = OrbitHost.density
    val type = when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        target = OrbitHost.hitTest(this, event.x, event.y)
        "topTouchStart"
      }
      MotionEvent.ACTION_MOVE -> "topTouchMove"
      MotionEvent.ACTION_UP -> "topTouchEnd"
      MotionEvent.ACTION_CANCEL -> "topTouchCancel"
      else -> return
    }
    target?.let { OrbitHost.nativeDispatch(it, type, event.x / d, event.y / d) }
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) target = null
  }
}

/** Attributed text decoded from orbit-host's encoding; measured and drawn alike. */
class OrbitText(val text: CharSequence, private val align: Layout.Alignment, private val paint: TextPaint) {
  fun layout(widthPx: Int): StaticLayout =
    StaticLayout.Builder.obtain(text, 0, text.length, paint, widthPx.coerceAtLeast(1))
      .setAlignment(align)
      .setIncludePad(false)
      .build()

  fun measure(maxWidthPx: Int): Pair<Float, Float> {
    val desired = ceil(Layout.getDesiredWidth(text, paint)).toInt()
    val laid = layout(minOf(desired, maxWidthPx))
    var width = 0f
    for (i in 0 until laid.lineCount) width = maxOf(width, laid.getLineWidth(i))
    return Pair(ceil(width), laid.height.toFloat())
  }

  companion object {
    fun decode(bytes: ByteArray, density: Float): OrbitText {
      val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      val align = when (buf.get().toInt()) {
        1 -> Layout.Alignment.ALIGN_CENTER
        2 -> Layout.Alignment.ALIGN_OPPOSITE
        else -> Layout.Alignment.ALIGN_NORMAL
      }
      buf.float // line height: not applied yet
      val runs = buf.int
      val out = SpannableStringBuilder()
      val paint = TextPaint(TextPaint.ANTI_ALIAS_FLAG)
      repeat(runs) { index ->
        val color = buf.int; val size = buf.float; val flags = buf.int
        val raw = ByteArray(buf.int)
        buf.get(raw)
        val start = out.length
        out.append(String(raw, Charsets.UTF_8))
        val end = out.length
        if (index == 0) {
          paint.textSize = size * density
          paint.color = color
        }
        out.setSpan(AbsoluteSizeSpan((size * density).toInt()), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        out.setSpan(ForegroundColorSpan(color), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        val style = (if (flags and 1 != 0) Typeface.BOLD else 0) or (if (flags and 2 != 0) Typeface.ITALIC else 0)
        if (style != 0) out.setSpan(StyleSpan(style), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
      return OrbitText(out, align, paint)
    }
  }
}

class OrbitTextView(context: Context) : View(context), Framed {
  val frame = FloatArray(4)
  private var text: OrbitText? = null
  private var laid: StaticLayout? = null

  fun setText(value: OrbitText) {
    text = value
    laid = value.layout(ceil(frame[2]).toInt())
    invalidate()
  }

  override fun setFrame(x: Float, y: Float, w: Float, h: Float) {
    val widthChanged = w != frame[2]
    frame[0] = x; frame[1] = y; frame[2] = w; frame[3] = h
    applyFrame(frame)
    if (widthChanged) laid = text?.layout(ceil(w).toInt())
    invalidate()
  }

  override fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) =
    applyLook(background, borderColor, borderWidth, radius, opacity)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(frame[2].toInt(), frame[3].toInt())
  }

  override fun onDraw(canvas: Canvas) {
    laid?.draw(canvas)
  }
}
