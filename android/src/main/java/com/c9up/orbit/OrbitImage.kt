package com.c9up.orbit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.LruCache
import android.view.View
import android.view.ViewOutlineProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A decoded image and the size its source declared. */
class Decoded(val bitmap: Bitmap, val naturalWidth: Int, val naturalHeight: Int)

/**
 * Where images come from, decoded off the UI thread at the size their view
 * shows them, and a bounded cache of what is decoded.
 *
 * Sources, as orbit's template writes them: `https://…`, `file:<path>`,
 * `content://…`, `asset:<name>` (bundled with the app) and `bytes:<n>` — the
 * bytes JS handed over for that node (`imageBytes`), held in memory only,
 * never written to disk, and zeroed when the node goes.
 */
object OrbitImages {
  /** A download or a local file larger than this is refused, not read. */
  private const val MAX_SOURCE_BYTES = 64 * 1024 * 1024
  /** No decoded side exceeds this, whatever the source declares. */
  private const val MAX_SIDE = 4096
  private const val TIMEOUT_MS = 15_000

  private val main = Handler(Looper.getMainLooper())
  private val workers = Executors.newFixedThreadPool(3) { task ->
    Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
      task.run()
    }, "orbit-image").apply { isDaemon = true }
  }

  // Bounded by decoded pixels: an eighth of what the app may allocate.
  private val cache = object : LruCache<String, Decoded>((Runtime.getRuntime().maxMemory() / 8 / 1024).toInt()) {
    override fun sizeOf(key: String, value: Decoded) = value.bitmap.allocationByteCount / 1024
  }

  /** UI thread only: the loads in flight, so one decode serves every view that waits for it. */
  private val pending = HashMap<String, MutableList<(Decoded?) -> Unit>>()

  private val bytes = HashMap<Int, ByteArray>()

  /** JS thread: the bytes a node shows from now on. */
  fun put(tag: Int, data: ByteArray) {
    val previous = synchronized(bytes) { bytes.put(tag, data) }
    previous?.fill(0)
  }

  /** UI thread: the node is gone — its bytes are zeroed, its decoded pixels evicted. */
  fun release(tag: Int) {
    val held = synchronized(bytes) { bytes.remove(tag) } ?: return
    held.fill(0)
    val prefix = "bytes:$tag:"
    for (key in cache.snapshot().keys) if (key.startsWith(prefix)) cache.remove(key)
  }

  /**
   * UI thread: `done` gets the image decoded for a `width` x `height` px view
   * under `fit`, on the UI thread, or null when it could not be loaded.
   */
  fun load(context: Context, src: String, tag: Int, width: Int, height: Int, fit: String, done: (Decoded?) -> Unit) {
    val source = if (src.startsWith("bytes:")) "bytes:$tag:${src.substring(6)}" else src
    val key = "$source@${width}x$height/$fit"
    cache.get(key)?.let { return done(it) }
    pending[key]?.let { it.add(done); return }
    pending[key] = mutableListOf(done)
    val app = context.applicationContext
    workers.execute {
      val decoded = try {
        decode(app, src, tag, width, height, fit)
      } catch (e: Exception) {
        android.util.Log.w("ORBIT", "image $src: ${e.message}")
        null
      } catch (e: OutOfMemoryError) {
        android.util.Log.w("ORBIT", "image $src: out of memory")
        null
      }
      main.post {
        if (decoded != null) cache.put(key, decoded)
        pending.remove(key)?.forEach { it(decoded) }
      }
    }
  }

  /**
   * The decoded size for a view: enough pixels for what the fit shows, never
   * more than the source has nor than MAX_SIDE — so what is allocated follows
   * the view, not the size a (possibly hostile) header claims.
   */
  private fun target(naturalW: Int, naturalH: Int, width: Int, height: Int, fit: String): Pair<Int, Int> {
    val w = max(naturalW, 1).toFloat()
    val h = max(naturalH, 1).toFloat()
    val x = max(width, 1) / w
    val y = max(height, 1) / h
    var scale = when (fit) {
      "cover" -> max(x, y)
      "none" -> 1f
      "fill" -> max(x, y)
      else -> min(x, y)
    }
    scale = min(scale, 1f)
    scale = min(scale, MAX_SIDE / max(w, h))
    return Pair(max((w * scale).roundToInt(), 1), max((h * scale).roundToInt(), 1))
  }

  private fun decode(context: Context, src: String, tag: Int, width: Int, height: Int, fit: String): Decoded? {
    var held: ByteArray? = null
    try {
      if (src.startsWith("bytes:")) {
        // A copy: the node may go (and its bytes be zeroed) while this decodes.
        held = synchronized(bytes) { bytes[tag]?.copyOf() } ?: return null
      } else if (src.startsWith("https://")) {
        held = download(src)
      }
      if (Build.VERSION.SDK_INT >= 28) {
        val source = when {
          held != null -> ImageDecoder.createSource(ByteBuffer.wrap(held))
          src.startsWith("file:") -> ImageDecoder.createSource(File(src.substring(5)))
          src.startsWith("content://") -> ImageDecoder.createSource(context.contentResolver, Uri.parse(src))
          src.startsWith("asset:") -> ImageDecoder.createSource(context.assets, src.substring(6))
          else -> return null
        }
        var naturalW = 0
        var naturalH = 0
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
          naturalW = info.size.width
          naturalH = info.size.height
          val (w, h) = target(naturalW, naturalH, width, height, fit)
          decoder.setTargetSize(w, h)
          // Software: the view may be drawn into a software canvas (snapshots, blur).
          decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        return Decoded(bitmap, naturalW, naturalH)
      }
      val data = held ?: when {
        src.startsWith("file:") -> File(src.substring(5)).inputStream().use(::readCapped)
        src.startsWith("content://") ->
          context.contentResolver.openInputStream(Uri.parse(src))?.use(::readCapped) ?: return null
        src.startsWith("asset:") -> context.assets.open(src.substring(6)).use(::readCapped)
        else -> return null
      }
      return decodeLegacy(data, width, height, fit)
    } finally {
      held?.fill(0)
    }
  }

  /** Before Android 9: BitmapFactory, sampled down by powers of two (no EXIF rotation). */
  private fun decodeLegacy(data: ByteArray, width: Int, height: Int, fit: String): Decoded? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val (w, h) = target(bounds.outWidth, bounds.outHeight, width, height, fit)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= w && bounds.outHeight / (sample * 2) >= h) sample *= 2
    // Never above MAX_SIDE, even when the fit wanted every pixel.
    while (max(bounds.outWidth, bounds.outHeight) / sample > MAX_SIDE) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size, options) ?: return null
    return Decoded(bitmap, bounds.outWidth, bounds.outHeight)
  }

  /** https only (the connection is refused otherwise), size-capped, with timeouts. */
  private fun download(url: String): ByteArray {
    val connection = URL(url).openConnection() as? HttpsURLConnection
      ?: throw IOException("not an https URL")
    try {
      connection.connectTimeout = TIMEOUT_MS
      connection.readTimeout = TIMEOUT_MS
      // HttpURLConnection never follows a redirect from https to http.
      connection.instanceFollowRedirects = true
      val status = connection.responseCode
      if (status !in 200..299) throw IOException("HTTP $status")
      if (connection.contentLengthLong > MAX_SOURCE_BYTES) throw IOException("larger than $MAX_SOURCE_BYTES bytes")
      return connection.inputStream.use(::readCapped)
    } finally {
      connection.disconnect()
    }
  }

  private fun readCapped(input: InputStream): ByteArray {
    val out = ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    while (true) {
      val n = input.read(chunk)
      if (n < 0) break
      if (out.size() + n > MAX_SOURCE_BYTES) throw IOException("larger than $MAX_SOURCE_BYTES bytes")
      out.write(chunk, 0, n)
    }
    return out.toByteArray()
  }
}

/**
 * `<img>`: draws the image orbit-host placed, fitted as CSS object-fit does
 * (`fill` by default), clipped to its rounded corners, with its border on top.
 */
class OrbitImage(context: Context) : View(context), Framed {
  val frame = FloatArray(4)
  private var src = ""
  private var fit = "fill"
  private var decoded: Decoded? = null
  /** The view size the current image was decoded for, in px. */
  private var decodedFor = Pair(0, 0)
  private var request = 0
  private var radius = 0f
  private var borderWidth = 0f
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val drawMatrix = Matrix()

  init {
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        val r = min(radius, min(view.width, view.height) / 2f)
        outline.setRoundRect(0, 0, view.width, view.height, r)
      }
    }
  }

  /** The image op's payload: `{src, fit, alt}`. */
  fun apply(json: String) {
    val props = JSONObject(json)
    val nextSrc = props.optString("src")
    val nextFit = props.optString("fit", "fill")
    val alt = props.optString("alt")
    contentDescription = alt.ifEmpty { null }
    importantForAccessibility =
      if (alt.isEmpty()) IMPORTANT_FOR_ACCESSIBILITY_NO else IMPORTANT_FOR_ACCESSIBILITY_YES
    val changed = nextSrc != src || nextFit != fit
    src = nextSrc
    fit = nextFit
    if (changed) {
      decoded = null
      decodedFor = Pair(0, 0)
      load()
    }
    invalidate()
  }

  override fun setFrame(x: Float, y: Float, w: Float, h: Float) {
    frame[0] = x; frame[1] = y; frame[2] = w; frame[3] = h
    applyFrame(frame)
    invalidateOutline()
    // Grown past what was decoded: decode again, sharper. Shrinking keeps it.
    val (dw, dh) = decodedFor
    if (ceil(w).toInt() > dw || ceil(h).toInt() > dh) load()
    invalidate()
  }

  override fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) {
    this.radius = radius
    this.borderWidth = borderWidth
    stroke.color = borderColor
    stroke.strokeWidth = borderWidth
    this.background = if (background == 0) null else GradientDrawable().apply {
      setColor(background)
      cornerRadius = radius
    }
    clipToOutline = radius > 0f
    invalidateOutline()
    alpha = opacity
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(frame[2].toInt(), frame[3].toInt())
  }

  private fun load() {
    val tag = tag as? Int ?: return
    val w = ceil(frame[2]).toInt()
    val h = ceil(frame[3]).toInt()
    if (src.isEmpty() || w <= 0 || h <= 0) return
    val token = ++request
    decodedFor = Pair(w, h)
    OrbitImages.load(context, src, tag, w, h, fit) { image ->
      if (token != request) return@load
      decoded = image
      invalidate()
    }
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    decoded?.let { image ->
      val bw = image.bitmap.width.toFloat()
      val bh = image.bitmap.height.toFloat()
      // `none` shows the natural size: one image pixel per dp, as one per CSS px.
      val natural = OrbitHost.density * image.naturalWidth / bw
      drawMatrix.reset()
      if (fit == "fill") {
        drawMatrix.setScale(w / bw, h / bh)
      } else {
        val contain = min(w / bw, h / bh)
        val scale = when (fit) {
          "cover" -> max(w / bw, h / bh)
          "none" -> natural
          "scale-down" -> min(contain, natural)
          else -> contain
        }
        drawMatrix.setScale(scale, scale)
        drawMatrix.postTranslate((w - bw * scale) / 2f, (h - bh * scale) / 2f)
      }
      canvas.save()
      canvas.clipRect(0f, 0f, w, h)
      canvas.drawBitmap(image.bitmap, drawMatrix, paint)
      canvas.restore()
    }
    if (borderWidth > 0f) {
      val inset = borderWidth / 2f
      val r = max(min(radius, min(w, h) / 2f) - inset, 0f)
      canvas.drawRoundRect(inset, inset, w - inset, h - inset, r, r, stroke)
    }
  }
}
