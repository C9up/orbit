#include "NativeOrbit.h"

#include <fbjni/fbjni.h>
#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <mutex>
#include <vector>

#include "orbit_host.h"

namespace facebook::react {

namespace {

// Cached from OrbitHost.nativeInit, which runs on a Java thread with the app's
// class loader: a FindClass from the JS thread would see the system loader.
jclass gHostClass = nullptr;
jmethodID gApply = nullptr;
jmethodID gMeasure = nullptr;
jmethodID gImageBytes = nullptr;

std::mutex gHandlerMutex;
std::shared_ptr<OrbitEventHandler> gHandler;
// The last safe-area size the platform reported (dp), replayed to a handler set later.
float gViewportWidth = 0;
float gViewportHeight = 0;

std::string takeString(OrbitBuf buf) {
  std::string s(reinterpret_cast<const char*>(buf.ptr), buf.len);
  orbit_buf_free(buf);
  return s;
}

// Called by orbit-host during layout, on the JS thread.
uint64_t measureText(const uint8_t* spans, size_t len, float maxWidth) {
  if (gHostClass == nullptr) {
    return 0;
  }
  JNIEnv* env = facebook::jni::Environment::current();
  jbyteArray bytes = env->NewByteArray(static_cast<jsize>(len));
  env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(len), reinterpret_cast<const jbyte*>(spans));
  jlong packed = env->CallStaticLongMethod(gHostClass, gMeasure, bytes, static_cast<jfloat>(maxWidth));
  env->DeleteLocalRef(bytes);
  return static_cast<uint64_t>(packed);
}

} // namespace

NativeOrbit::NativeOrbit(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeOrbitCxxSpec(std::move(jsInvoker)) {
  orbit_set_measure(&measureText);
}

void NativeOrbit::setViewport(jsi::Runtime&, double width, double height) {
  orbit_set_viewport(static_cast<float>(width), static_cast<float>(height));
}

std::string NativeOrbit::commit(jsi::Runtime& rt, std::string ops) {
  OrbitBuf mountOps{};
  OrbitBuf info{};
  int32_t code = orbit_commit(reinterpret_cast<const uint8_t*>(ops.data()), ops.size(), &mountOps, &info);
  if (code == 0 && mountOps.len > 0 && gHostClass != nullptr) {
    JNIEnv* env = facebook::jni::Environment::current();
    jbyteArray bytes = env->NewByteArray(static_cast<jsize>(mountOps.len));
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(mountOps.len), reinterpret_cast<const jbyte*>(mountOps.ptr));
    env->CallStaticVoidMethod(gHostClass, gApply, bytes);
    env->DeleteLocalRef(bytes);
  }
  orbit_buf_free(mountOps);
  std::string report = takeString(info);
  if (code != 0) {
    throw jsi::JSError(rt, report);
  }
  return report;
}

// The bytes of an `<img src=${bytes}>`: a Uint8Array (any typed-array view) or
// an ArrayBuffer, copied straight into the Kotlin side's memory.
void NativeOrbit::imageBytes(jsi::Runtime& rt, double tag, jsi::Object bytes) {
  const char* refused = "[orbit] imageBytes expects a Uint8Array or an ArrayBuffer";
  std::optional<jsi::ArrayBuffer> buffer;
  size_t offset = 0;
  size_t length = 0;
  if (bytes.isArrayBuffer(rt)) {
    buffer.emplace(bytes.getArrayBuffer(rt));
    length = buffer->size(rt);
  } else {
    jsi::Value inner = bytes.getProperty(rt, "buffer");
    jsi::Value byteOffset = bytes.getProperty(rt, "byteOffset");
    jsi::Value byteLength = bytes.getProperty(rt, "byteLength");
    if (!inner.isObject() || !byteOffset.isNumber() || !byteLength.isNumber()) {
      throw jsi::JSError(rt, refused);
    }
    jsi::Object object = inner.getObject(rt);
    if (!object.isArrayBuffer(rt) || byteOffset.getNumber() < 0 || byteLength.getNumber() < 0) {
      throw jsi::JSError(rt, refused);
    }
    buffer.emplace(object.getArrayBuffer(rt));
    offset = static_cast<size_t>(byteOffset.getNumber());
    length = static_cast<size_t>(byteLength.getNumber());
  }
  size_t size = buffer->size(rt);
  if (offset > size || length > size - offset || length > static_cast<size_t>(INT32_MAX)) {
    throw jsi::JSError(rt, "[orbit] imageBytes: the view runs past its buffer");
  }
  if (gHostClass == nullptr) {
    return;
  }
  JNIEnv* env = facebook::jni::Environment::current();
  jbyteArray array = env->NewByteArray(static_cast<jsize>(length));
  env->SetByteArrayRegion(
      array, 0, static_cast<jsize>(length), reinterpret_cast<const jbyte*>(buffer->data(rt) + offset));
  env->CallStaticVoidMethod(gHostClass, gImageBytes, static_cast<jint>(tag), array);
  env->DeleteLocalRef(array);
}

void NativeOrbit::setEventHandler(jsi::Runtime&, OrbitEventHandler handler) {
  std::lock_guard<std::mutex> lock(gHandlerMutex);
  gHandler = std::make_shared<OrbitEventHandler>(std::move(handler));
  // The platform may have reported the safe area before JS listened.
  if (gViewportWidth > 0 && gViewportHeight > 0) {
    gHandler->call(0.0, std::string("topViewport"), gViewportWidth, gViewportHeight, std::string());
  }
}

void NativeOrbit::motionValue(jsi::Runtime&, double tag, double initial) {
  orbit_motion_value(static_cast<int32_t>(tag), initial);
}

void NativeOrbit::motionInterpolate(
    jsi::Runtime&, double tag, double input, std::vector<double> from, std::vector<double> to) {
  size_t len = std::min(from.size(), to.size());
  orbit_motion_interpolate(static_cast<int32_t>(tag), static_cast<int32_t>(input), from.data(), to.data(), len);
}

void NativeOrbit::motionSet(jsi::Runtime&, double tag, double value) {
  orbit_motion_set(static_cast<int32_t>(tag), value);
}

void NativeOrbit::motionStop(jsi::Runtime&, double tag) {
  orbit_motion_stop(static_cast<int32_t>(tag));
}

void NativeOrbit::motionFrames(jsi::Runtime&, double tag, std::vector<double> frames, double to, bool loop) {
  orbit_motion_frames(static_cast<int32_t>(tag), frames.data(), frames.size(), to, loop);
}

void NativeOrbit::motionSpring(jsi::Runtime&, double tag, double to, double stiffness, double damping, double mass) {
  orbit_motion_spring(static_cast<int32_t>(tag), to, stiffness, damping, mass);
}

void NativeOrbit::motionBind(jsi::Runtime&, double view, double prop, double node) {
  orbit_motion_bind(static_cast<int32_t>(view), static_cast<uint8_t>(prop), static_cast<int32_t>(node));
}

void NativeOrbit::motionBindScroll(jsi::Runtime&, double scrollView, double value) {
  orbit_motion_bind_scroll(static_cast<int32_t>(scrollView), static_cast<int32_t>(value));
}

} // namespace facebook::react

// UI thread, every vsync: advance orbit-host's animations. Returns the
// records (i32 view, u8 prop, f32 value), prefixed by one byte: 1 while running.
extern "C" JNIEXPORT jbyteArray JNICALL Java_com_c9up_orbit_OrbitHost_nativeTick(
    JNIEnv* env, jclass, jlong nowNs, jintArray scrollTags, jfloatArray scrollY) {
  jsize count = env->GetArrayLength(scrollTags);
  std::vector<int32_t> tags(count);
  std::vector<float> ys(count);
  if (count > 0) {
    env->GetIntArrayRegion(scrollTags, 0, count, reinterpret_cast<jint*>(tags.data()));
    env->GetFloatArrayRegion(scrollY, 0, count, ys.data());
  }
  OrbitBuf out{};
  int32_t active = orbit_motion_tick(nowNs, tags.data(), ys.data(), static_cast<size_t>(count), &out);
  jbyteArray result = env->NewByteArray(static_cast<jsize>(out.len + 1));
  jbyte flag = static_cast<jbyte>(active);
  env->SetByteArrayRegion(result, 0, 1, &flag);
  if (out.len > 0) {
    env->SetByteArrayRegion(result, 1, static_cast<jsize>(out.len), reinterpret_cast<const jbyte*>(out.ptr));
  }
  orbit_buf_free(out);
  return result;
}

extern "C" JNIEXPORT void JNICALL Java_com_c9up_orbit_OrbitHost_nativeInit(JNIEnv* env, jclass cls) {
  using namespace facebook::react;
  if (gHostClass == nullptr) {
    gHostClass = static_cast<jclass>(env->NewGlobalRef(cls));
    gApply = env->GetStaticMethodID(cls, "apply", "([B)V");
    gMeasure = env->GetStaticMethodID(cls, "measureText", "([BF)J");
    gImageBytes = env->GetStaticMethodID(cls, "imageBytes", "(I[B)V");
  }
}

extern "C" JNIEXPORT void JNICALL Java_com_c9up_orbit_OrbitHost_nativeDispatch(
    JNIEnv* env, jclass, jint tag, jstring type, jfloat x, jfloat y) {
  using namespace facebook::react;
  std::shared_ptr<OrbitEventHandler> handler;
  {
    std::lock_guard<std::mutex> lock(gHandlerMutex);
    handler = gHandler;
  }
  if (!handler) {
    return;
  }
  const char* chars = env->GetStringUTFChars(type, nullptr);
  std::string name(chars);
  env->ReleaseStringUTFChars(type, chars);
  // Scheduled onto the JS thread by the callback itself.
  handler->call(static_cast<double>(tag), std::move(name), static_cast<double>(x), static_cast<double>(y), std::string());
}


// A text field's event (`topChange`, `topFocus`, `topBlur`, `topSubmit`) with its text.
extern "C" JNIEXPORT void JNICALL Java_com_c9up_orbit_OrbitHost_nativeDispatchText(
    JNIEnv* env, jclass, jint tag, jstring type, jstring text) {
  using namespace facebook::react;
  std::shared_ptr<OrbitEventHandler> handler;
  {
    std::lock_guard<std::mutex> lock(gHandlerMutex);
    handler = gHandler;
  }
  if (!handler) {
    return;
  }
  auto read = [env](jstring s) {
    const char* chars = env->GetStringUTFChars(s, nullptr);
    std::string out(chars);
    env->ReleaseStringUTFChars(s, chars);
    return out;
  };
  handler->call(static_cast<double>(tag), read(type), 0.0, 0.0, read(text));
}

// The safe area (dp) changed: remembered, and sent to JS if it listens.
extern "C" JNIEXPORT void JNICALL Java_com_c9up_orbit_OrbitHost_nativeViewport(JNIEnv*, jclass, jfloat width, jfloat height) {
  using namespace facebook::react;
  std::shared_ptr<OrbitEventHandler> handler;
  {
    std::lock_guard<std::mutex> lock(gHandlerMutex);
    gViewportWidth = width;
    gViewportHeight = height;
    handler = gHandler;
  }
  if (handler) {
    handler->call(0.0, std::string("topViewport"), static_cast<double>(width), static_cast<double>(height), std::string());
  }
}
