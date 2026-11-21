package com.c9up.orbit

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/**
 * An `<svg>`: the paths orbit-host resolved (`vector.rs`), replayed scaled to
 * the view's box — the viewBox centred and fitted (`xMidYMid meet`), or
 * stretched (`none`). Paths are built once per drawing, not per frame.
 */
class OrbitVector(context: Context) : View(context), Framed {
  val frame = FloatArray(4)

  private class Shape(val path: Path, val fill: Paint?, val stroke: Paint?)

  private var shapes: List<Shape> = emptyList()
  private val viewBox = FloatArray(4)
  private var stretch = false

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  /** The vector op's payload (see `vector.rs` for the encoding). */
  fun apply(bytes: ByteArray) {
    val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until 4) viewBox[i] = buf.float
    stretch = buf.get().toInt() == 1
    val count = buf.int
    val next = ArrayList<Shape>(count)
    repeat(count) {
      val fillColor = buf.int
      val evenOdd = buf.get().toInt() == 1
      val strokeColor = buf.int
      val strokeWidth = buf.float
      val cap = buf.get().toInt()
      val join = buf.get().toInt()
      val miter = buf.float
      val crisp = buf.get().toInt() == 1
      val path = Path()
      path.fillType = if (evenOdd) Path.FillType.EVEN_ODD else Path.FillType.WINDING
      repeat(buf.int) {
        when (buf.get().toInt()) {
          0 -> path.moveTo(buf.float, buf.float)
          1 -> path.lineTo(buf.float, buf.float)
          2 -> path.cubicTo(buf.float, buf.float, buf.float, buf.float, buf.float, buf.float)
          3 -> path.quadTo(buf.float, buf.float, buf.float, buf.float)
          else -> path.close()
        }
      }
      val fill = if (fillColor == 0) null else Paint().apply {
        isAntiAlias = !crisp
        style = Paint.Style.FILL
        color = fillColor
      }
      val stroke = if (strokeColor == 0 || strokeWidth <= 0f) null else Paint().apply {
        isAntiAlias = !crisp
        style = Paint.Style.STROKE
        color = strokeColor
        this.strokeWidth = strokeWidth
        strokeCap = when (cap) {
          1 -> Paint.Cap.ROUND
          2 -> Paint.Cap.SQUARE
          else -> Paint.Cap.BUTT
        }
        strokeJoin = when (join) {
          1 -> Paint.Join.ROUND
          2 -> Paint.Join.BEVEL
          else -> Paint.Join.MITER
        }
        strokeMiter = miter
      }
      next.add(Shape(path, fill, stroke))
    }
    shapes = next
    invalidate()
  }

  override fun setFrame(x: Float, y: Float, w: Float, h: Float) {
    frame[0] = x; frame[1] = y; frame[2] = w; frame[3] = h
    applyFrame(frame)
    invalidate()
  }

  override fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) {
    applyLook(background, borderColor, borderWidth, radius, opacity)
  }

  override fun onDraw(canvas: Canvas) {
    val (minX, minY, vw, vh) = viewBox
    if (vw <= 0f || vh <= 0f || shapes.isEmpty()) return
    val w = width.toFloat()
    val h = height.toFloat()
    canvas.save()
    if (stretch) {
      canvas.scale(w / vw, h / vh)
    } else {
      val s = min(w / vw, h / vh)
      canvas.translate((w - vw * s) / 2f, (h - vh * s) / 2f)
      canvas.scale(s, s)
    }
    canvas.translate(-minX, -minY)
    for (shape in shapes) {
      shape.fill?.let { canvas.drawPath(shape.path, it) }
      shape.stroke?.let { canvas.drawPath(shape.path, it) }
    }
    canvas.restore()
  }
}
