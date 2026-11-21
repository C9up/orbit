package com.c9up.orbit

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import java.util.WeakHashMap
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A CSS box shadow, in px: offset, blur radius (CSS's, twice the Gaussian's sigma), spread, colour. */
class Shadow(val dx: Float, val dy: Float, val blur: Float, val spread: Float, val color: Int)

/**
 * What orbit's views draw beyond their box, on the hardware canvas:
 *
 * - box shadows (Android 8+): a parent draws each child's shadow just before
 *   the child, outside the child's rounded box — as CSS draws it, so a
 *   translucent view does not show its own shadow through itself;
 * - backdrop blur (Android 12+): a glass view records what its parent drew
 *   before it (the parent's background and earlier siblings, each a render
 *   node already recorded this frame) into a render node blurred by
 *   `RenderEffect`, and draws that under its own translucent background.
 *   Below Android 12 it keeps the translucent background alone.
 */
object OrbitEffects {
  private const val BACKDROP_SCALE = 0.25f
  private val shadows = WeakHashMap<View, Shadow>()
  private val radii = WeakHashMap<View, Float>()
  /** Views whose fill is opaque: they hide their own shadow, no clip needed. */
  private val opaque = WeakHashMap<View, Boolean>()
  private val glasses = WeakHashMap<OrbitBox, Boolean>()
  private val path = Path()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val blurs = HashMap<Float, BlurMaskFilter>()
  /** Set while a glass records its backdrop: a glass inside it draws none. */
  private var capturing = false
  private val listened = WeakHashMap<ViewTreeObserver, Boolean>()

  /** Skia's radius for a Gaussian of `sigma` (what BlurMaskFilter and RenderEffect take). */
  private fun skiaRadius(sigma: Float) = max((sigma - 0.5f) / 0.57735f, 0f)

  fun setRadius(view: View, radius: Float) {
    radii[view] = radius
  }

  fun radiusOf(view: View): Float = radii[view] ?: 0f

  private val fills = WeakHashMap<View, Int>()

  fun setFill(view: View, fill: Int) {
    fills[view] = fill
  }

  /** A fill dark enough that a light ripple reads on it. */
  fun isDark(view: View): Boolean {
    val fill = fills[view] ?: return false
    if ((fill ushr 24) < 0x80) return false
    val luminance = 0.2126 * ((fill shr 16) and 0xff) + 0.7152 * ((fill shr 8) and 0xff) + 0.0722 * (fill and 0xff)
    return luminance < 140
  }

  fun setOpaque(view: View, isOpaque: Boolean) {
    if (isOpaque) opaque[view] = true else opaque.remove(view)
  }

  /** The view's effects op, sizes already in px. */
  fun apply(view: View, shadow: Shadow?, backdropSigma: Float, clip: Boolean) {
    if (shadow == null || shadow.color ushr 24 == 0) shadows.remove(view) else shadows[view] = shadow
    (view.parent as? View)?.invalidate()
    val box = view as? OrbitBox ?: return
    box.setClip(clip)
    box.backdropSigma = backdropSigma
    if (backdropSigma > 0f) {
      glasses[box] = true
      box.setWillNotDraw(false)
      listen(box)
    } else {
      glasses.remove(box)
    }
    box.invalidate()
  }

  /** Something under a glass may have moved: scrolled, mounted or animated. */
  fun invalidateBackdrops() {
    for (glass in glasses.keys) glass.invalidate()
  }

  private fun listen(view: View) {
    val observer = view.viewTreeObserver
    if (!observer.isAlive || listened.containsKey(observer)) return
    listened[observer] = true
    observer.addOnScrollChangedListener { invalidateBackdrops() }
  }

  /** Called by a parent before it draws `child`. */
  fun drawShadow(canvas: Canvas, child: View) {
    // Not into a backdrop: the blur washes it out, and a blurred shadow drawn
    // into a scaled offscreen layer missed Skia's mask cache every frame
    // (several ms of RenderThread work for nothing visible).
    if (Build.VERSION.SDK_INT < 26 || capturing) return
    val shadow = shadows[child] ?: return
    if (child.visibility != View.VISIBLE || child.alpha <= 0f) return
    val w = child.width.toFloat()
    val h = child.height.toFloat()
    if (w <= 0f || h <= 0f) return
    val radius = min(radii[child] ?: 0f, min(w, h) / 2f)
    canvas.save()
    canvas.translate(child.left + child.translationX, child.top + child.translationY)
    if (child.scaleX != 1f || child.scaleY != 1f) {
      canvas.scale(child.scaleX, child.scaleY, child.pivotX, child.pivotY)
    }
    // CSS paints a shadow outside the border box only. An opaque view covers
    // the part under it anyway, and the clip (a mask per draw on the GPU) is
    // what a list of shadowed cards paid for most: only a translucent view
    // gets it.
    if (opaque[child] != true || child.alpha < 1f) {
      if (radius > 0f) {
        path.reset()
        path.addRoundRect(0f, 0f, w, h, radius, radius, Path.Direction.CW)
        canvas.clipOutPath(path)
      } else {
        canvas.clipOutRect(0f, 0f, w, h)
      }
    }
    paint.color = shadow.color
    paint.alpha = (((shadow.color ushr 24) and 0xff) * child.alpha).toInt()
    val s = shadow.spread
    val r = max(radius + s, 0f)
    val left = -s + shadow.dx
    val top = -s + shadow.dy
    val right = w + s + shadow.dx
    val bottom = h + s + shadow.dy
    // CSS blur radius B is a Gaussian of sigma B / 2.
    val sigma = shadow.blur / 2f
    if (sigma <= 0f) {
      paint.maskFilter = null
      canvas.drawRoundRect(left, top, right, bottom, r, r, paint)
    } else if (!drawSprite(canvas, sprite(r, sigma), left, top, right, bottom)) {
      // Too small for nine slices: blurred directly.
      paint.maskFilter = blurs.getOrPut(sigma) { BlurMaskFilter(skiaRadius(sigma), BlurMaskFilter.Blur.NORMAL) }
      canvas.drawRoundRect(left, top, right, bottom, r, r, paint)
      paint.maskFilter = null
    }
    canvas.restore()
  }

  /**
   * A blurred rounded rectangle rendered once into an alpha bitmap, drawn as
   * nine slices at any size — what browsers do with box shadows. Blurring per
   * draw cost GPU time on every frame, and missed Skia's mask cache entirely
   * when the shadow was replayed into a scaled layer (a glass's backdrop).
   *
   * In the bitmap's pixels: the shape sits `reach` (3 sigma) in from each
   * side; a corner slice is `corner` = 2 reach + radius square, so the middle
   * row and column, one pixel wide, lie on the shape's straight edges at
   * least 3 sigma from its corners — the profile there is the true edge's.
   */
  private class Sprite(val bitmap: Bitmap, val scale: Float, val corner: Int, val reach: Int)

  private val sprites = object : LinkedHashMap<String, Sprite>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Sprite>?) = size > 48
  }
  private val spritePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val src = Rect()
  private val dst = RectF()

  private fun sprite(radius: Float, sigma: Float): Sprite {
    // A blurred shape needs little resolution: a few pixels of sigma.
    val scale = min(1f, max(0.25f, 4f / sigma))
    val key = "${(radius * scale).roundToInt()}:${(sigma * scale * 10f).roundToInt()}:$scale"
    sprites[key]?.let { return it }
    val sigmaPx = sigma * scale
    val reach = ceil(3f * sigmaPx).toInt()
    val r = (radius * scale).roundToInt()
    val corner = 2 * reach + r
    val side = 2 * corner + 1
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ALPHA_8)
    spritePaint.maskFilter = BlurMaskFilter(skiaRadius(sigmaPx), BlurMaskFilter.Blur.NORMAL)
    Canvas(bitmap).drawRoundRect(
      reach.toFloat(), reach.toFloat(), (side - reach).toFloat(), (side - reach).toFloat(),
      r.toFloat(), r.toFloat(), spritePaint,
    )
    return Sprite(bitmap, scale, corner, reach).also { sprites[key] = it }
  }

  /** Nine slices of `sprite` around the shape [left, top, right, bottom]; false when it is too small. */
  private fun drawSprite(canvas: Canvas, sprite: Sprite, left: Float, top: Float, right: Float, bottom: Float): Boolean {
    val k = sprite.scale
    val reach = sprite.reach / k
    val corner = sprite.corner / k
    val x0 = left - reach
    val y0 = top - reach
    val x3 = right + reach
    val y3 = bottom + reach
    if (x3 - x0 < 2 * corner || y3 - y0 < 2 * corner) return false
    val x1 = x0 + corner
    val x2 = x3 - corner
    val y1 = y0 + corner
    val y2 = y3 - corner
    val c = sprite.corner
    val side = sprite.bitmap.width
    val xs = intArrayOf(0, c, c + 1, side)
    val ys = intArrayOf(0, c, c + 1, side)
    val dx = floatArrayOf(x0, x1, x2, x3)
    val dy = floatArrayOf(y0, y1, y2, y3)
    paint.isFilterBitmap = true
    for (j in 0 until 3) {
      for (i in 0 until 3) {
        src.set(xs[i], ys[j], xs[i + 1], ys[j + 1])
        dst.set(dx[i], dy[j], dx[i + 1], dy[j + 1])
        canvas.drawBitmap(sprite.bitmap, src, dst, paint)
      }
    }
    return true
  }

  /** Called by a glass before it draws its background. */
  fun drawBackdrop(glass: OrbitBox, canvas: Canvas) {
    if (Build.VERSION.SDK_INT < 31 || capturing || !canvas.isHardwareAccelerated) return
    val parent = glass.parent as? ViewGroup ?: return
    val w = glass.width
    val h = glass.height
    if (w <= 0 || h <= 0) return
    val node = glass.backdropNode as? RenderNode ?: RenderNode("orbit-backdrop").also {
      glass.backdropNode = it
      it.setPivotX(0f)
      it.setPivotY(0f)
      it.setScaleX(1f / BACKDROP_SCALE)
      it.setScaleY(1f / BACKDROP_SCALE)
    }
    // A blurred backdrop needs no resolution: it is recorded and blurred at a
    // quarter of the size (a sixteenth of the pixels), then drawn scaled up.
    val sw = ceil(w * BACKDROP_SCALE).toInt().coerceAtLeast(1)
    val sh = ceil(h * BACKDROP_SCALE).toInt().coerceAtLeast(1)
    node.setPosition(0, 0, sw, sh)
    if (glass.appliedSigma != glass.backdropSigma) {
      val r = skiaRadius(glass.backdropSigma * BACKDROP_SCALE)
      node.setRenderEffect(RenderEffect.createBlurEffect(r, r, Shader.TileMode.CLAMP))
      glass.appliedSigma = glass.backdropSigma
    }
    val recording = node.beginRecording(sw, sh)
    capturing = true
    try {
      recording.scale(BACKDROP_SCALE, BACKDROP_SCALE)
      recording.translate(-(glass.left + glass.translationX), -(glass.top + glass.translationY))
      parent.background?.draw(recording)
      for (i in 0 until parent.childCount) {
        val sibling = parent.getChildAt(i)
        if (sibling === glass) break
        if (sibling.visibility != View.VISIBLE) continue
        recording.save()
        recording.translate(sibling.left + sibling.translationX, sibling.top + sibling.translationY)
        // A scrolling sibling shows only its viewport; its content is offset by its scroll.
        if (sibling is OrbitScroll || (sibling as? ViewGroup)?.clipChildren == true) {
          recording.clipRect(0, 0, sibling.width, sibling.height)
        }
        recording.translate(-sibling.scrollX.toFloat(), -sibling.scrollY.toFloat())
        sibling.draw(recording)
        recording.restore()
      }
    } finally {
      capturing = false
      node.endRecording()
    }
    val radius = min(radii[glass] ?: 0f, min(w, h) / 2f)
    canvas.save()
    path.reset()
    path.addRoundRect(0f, 0f, w.toFloat(), h.toFloat(), radius, radius, Path.Direction.CW)
    canvas.clipPath(path)
    canvas.drawRenderNode(node)
    canvas.restore()
  }
}
