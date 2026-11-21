package com.c9up.orbit

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.View
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.WeakHashMap

/**
 * Applies what orbit-host's gesture recognizer (Rust, on this UI thread)
 * decides: the press feedback, a ripple started here without waiting for JS;
 * a gesture claimed by a view; and the events JS receives when it can.
 * Command codes match crates/orbit-host/src/gesture.rs.
 */
object OrbitPress {
  private const val CMD_PRESSED = 1
  private const val CMD_CLAIM = 2
  private const val CMD_EVENT = 3

  private val masks = WeakHashMap<View, GradientDrawable>()
  private val pressed = intArrayOf(android.R.attr.state_pressed, android.R.attr.state_enabled)
  private val idle = intArrayOf(android.R.attr.state_enabled)

  /** Applies `commands`; true when a view claimed the gesture. */
  fun apply(root: OrbitRoot, commands: ByteArray): Boolean {
    if (commands.isEmpty()) return false
    var claimed = false
    val buf = ByteBuffer.wrap(commands).order(ByteOrder.LITTLE_ENDIAN)
    while (buf.hasRemaining()) {
      when (buf.get().toInt()) {
        CMD_PRESSED -> {
          val tag = buf.int
          val on = buf.get().toInt() != 0
          val x = buf.float
          val y = buf.float
          OrbitHost.viewOf(tag)?.let { setPressed(root, it, on, x, y) }
        }
        CMD_CLAIM -> {
          buf.int
          claimed = true
        }
        CMD_EVENT -> {
          val tag = buf.int
          val type = string(buf)
          val data = string(buf)
          OrbitHost.nativeDispatchText(tag, type, data)
        }
        else -> return claimed
      }
    }
    return claimed
  }

  private fun string(buf: ByteBuffer): String {
    val bytes = ByteArray(buf.int)
    buf.get(bytes)
    return String(bytes, Charsets.UTF_8)
  }

  /**
   * The ripple: masked by the view's own rounded box (spike 4's was
   * rectangular), starting where the finger is in the pressable view (spike
   * 4 used the deepest view's coordinates). Light on a dark fill, dark on a
   * light one, as Material does.
   */
  private fun setPressed(root: OrbitRoot, view: View, on: Boolean, xDp: Float, yDp: Float) {
    val ripple = rippleOf(view)
    if (on) {
      val (left, top) = offsetIn(root.content, view)
      val d = OrbitHost.density
      ripple.setHotspot(xDp * d - left, yDp * d - top)
    }
    ripple.state = if (on) pressed else idle
  }

  private fun rippleOf(view: View): RippleDrawable {
    val radius = OrbitEffects.radiusOf(view)
    val existing = view.foreground as? RippleDrawable
    if (existing != null) {
      masks[view]?.cornerRadius = radius
      return existing
    }
    val mask = GradientDrawable().apply {
      setColor(Color.WHITE)
      cornerRadius = radius
    }
    masks[view] = mask
    val color = if (OrbitEffects.isDark(view)) 0x3DFFFFFF else 0x1F000000
    return RippleDrawable(ColorStateList.valueOf(color), null, mask).also { view.foreground = it }
  }

  /** Where `view` sits in `content`, in px: offsets, translations and scrolls on the way. */
  private fun offsetIn(content: View, view: View): Pair<Float, Float> {
    var x = 0f
    var y = 0f
    var at: View = view
    while (at !== content) {
      x += at.left + at.translationX
      y += at.top + at.translationY
      val parent = at.parent as? View ?: break
      x -= parent.scrollX
      y -= parent.scrollY
      at = parent
    }
    return Pair(x, y)
  }
}
