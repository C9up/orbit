package com.c9up.orbit

import android.content.Context
import android.graphics.Typeface
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import org.json.JSONObject
import kotlin.math.ceil

/**
 * A text field orbit-host lays out. The field owns its text while the user
 * types: each change goes to JS (`topChange`), and JS's value comes back only
 * with a newer `textVersion` — so typing never waits for JS and the caret
 * never jumps.
 */
class OrbitInput(context: Context) : EditText(context), Framed {
  val frame = FloatArray(4)
  private var appliedVersion = -1
  private var muted = false
  private var lastJson = ""

  init {
    // orbit-host sends a field's props before it attaches the field to its
    // parent, and TextView reads its layout params on every text change.
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    background = null
    includeFontPadding = false
    // Its text scrolls inside it: clipped to its box, whatever its parent clips.
    clipToOwnBox()
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable?) {
        if (!muted) send("topChange")
      }
    })
    setOnFocusChangeListener { _, focused -> send(if (focused) "topFocus" else "topBlur") }
    // The keyboard's action (send, done) submits once. A hardware or emulated
    // Enter arrives as IME_NULL twice, key down then key up: only the down
    // submits. In a multi-line field Enter is a new line.
    setOnEditorActionListener { _, action, event ->
      val imeAction = action != EditorInfo.IME_NULL
      when {
        imeAction -> { send("topSubmit"); true }
        isMultiline() -> false
        event?.action == KeyEvent.ACTION_DOWN -> { send("topSubmit"); true }
        else -> true
      }
    }
  }

  private fun send(type: String) {
    val tag = tag as? Int ?: return
    OrbitHost.nativeDispatchText(tag, type, text?.toString() ?: "")
  }

  private fun isMultiline() = inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0

  /** Apply orbit-host's INPUT payload (JSON); sizes in dp. */
  fun apply(json: String, density: Float) {
    if (json == lastJson) return
    lastJson = json
    val p = JSONObject(json)
    hint = p.optString("placeholder", "")
    if (p.has("placeholderColor")) setHintTextColor(p.getInt("placeholderColor"))
    if (p.has("color")) setTextColor(p.getInt("color"))
    setTextSize(TypedValue.COMPLEX_UNIT_DIP, p.optDouble("fontSize", 14.0).toFloat())
    val weight = p.optString("fontWeight", "400")
    val bold = weight == "bold" || (weight.toIntOrNull() ?: 400) >= 600
    val italic = p.optString("fontStyle") == "italic"
    setTypeface(Typeface.DEFAULT, (if (bold) Typeface.BOLD else 0) or (if (italic) Typeface.ITALIC else 0))

    val multiline = p.optBoolean("multiline", false)
    var type = when (p.optString("keyboard", "text")) {
      "email" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
      "numeric" -> InputType.TYPE_CLASS_NUMBER
      "decimal" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
      "phone" -> InputType.TYPE_CLASS_PHONE
      "url" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
      else -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    }
    if (p.optBoolean("secure", false)) type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    if (multiline) type = type or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    if (inputType != type) inputType = type
    val rows = p.optInt("rows", 1).coerceAtLeast(1)
    if (multiline) {
      minLines = rows
      gravity = Gravity.TOP or Gravity.START
      isSingleLine = false
    } else {
      isSingleLine = true
      gravity = Gravity.CENTER_VERTICAL or Gravity.START
      imeOptions = EditorInfo.IME_ACTION_SEND
    }
    val max = p.optInt("maxLength", 0)
    filters = if (max > 0) arrayOf(InputFilter.LengthFilter(max)) else arrayOf()
    val editable = p.optBoolean("editable", true)
    isEnabled = editable
    isFocusableInTouchMode = editable

    val pad = p.optJSONArray("padding")
    if (pad != null && pad.length() == 4) {
      val px = { i: Int -> ceil(pad.getDouble(i) * density).toInt() }
      setPadding(px(0), px(1), px(2), px(3))
    }

    val version = p.optInt("textVersion", 0)
    val next = p.optString("text", "")
    if (version > appliedVersion) {
      appliedVersion = version
      if (next != text?.toString()) {
        muted = true
        setText(next)
        setSelection(next.length)
        muted = false
      }
    }
  }

  override fun setFrame(x: Float, y: Float, w: Float, h: Float) {
    frame[0] = x; frame[1] = y; frame[2] = w; frame[3] = h
    measure(
      MeasureSpec.makeMeasureSpec(w.toInt(), MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(h.toInt(), MeasureSpec.EXACTLY))
    applyFrame(frame)
  }

  override fun setLook(background: Int, borderColor: Int, borderWidth: Float, radius: Float, opacity: Float) =
    applyLook(background, borderColor, borderWidth, radius, opacity)

  // A text field lays its text out in onMeasure: measure it at its frame.
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(
      MeasureSpec.makeMeasureSpec(frame[2].toInt(), MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(frame[3].toInt(), MeasureSpec.EXACTLY))
  }
}
