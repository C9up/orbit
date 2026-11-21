#pragma once

#include <cstddef>
#include <cstdint>

extern "C" {

struct OrbitBuf {
  uint8_t* ptr;
  size_t len;
  size_t cap;
};

typedef uint64_t (*OrbitMeasureFn)(const uint8_t* spans, size_t len, float maxWidth);

void orbit_set_measure(OrbitMeasureFn measure);
void orbit_set_viewport(float width, float height);
int32_t orbit_commit(const uint8_t* ops, size_t len, OrbitBuf* mountOps, OrbitBuf* info);
int32_t orbit_layout(const uint8_t* tags, size_t len, OrbitBuf* out);
void orbit_touch(uint8_t action, float x, float y, int64_t nowNs, int32_t hit, OrbitBuf* out);
void orbit_gesture_tick(int64_t nowNs, OrbitBuf* out);
void orbit_buf_free(OrbitBuf buf);

void orbit_motion_value(int32_t tag, double initial);
void orbit_motion_interpolate(int32_t tag, int32_t input, const double* from, const double* to, size_t len);
void orbit_motion_set(int32_t tag, double value);
void orbit_motion_stop(int32_t tag);
void orbit_motion_frames(int32_t tag, const double* frames, size_t len, double to, bool looping);
void orbit_motion_spring(int32_t tag, double to, double stiffness, double damping, double mass);
void orbit_motion_bind(int32_t view, uint8_t prop, int32_t node);
void orbit_motion_bind_scroll(int32_t scrollView, int32_t value);
int32_t orbit_motion_tick(int64_t nowNs, const int32_t* scrollTags, const float* scrollY, size_t count, OrbitBuf* out);
}
