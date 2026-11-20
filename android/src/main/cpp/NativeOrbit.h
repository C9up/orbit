#pragma once

#include <AppSpecsJSI.h>

#include <memory>
#include <string>
#include <vector>

namespace facebook::react {

using OrbitEventHandler = AsyncCallback<double, std::string, double, double, std::string>;

class NativeOrbit : public NativeOrbitCxxSpec<NativeOrbit> {
 public:
  explicit NativeOrbit(std::shared_ptr<CallInvoker> jsInvoker);

  void setViewport(jsi::Runtime& rt, double width, double height);
  std::string commit(jsi::Runtime& rt, std::string ops);
  void setEventHandler(jsi::Runtime& rt, OrbitEventHandler handler);

  void motionValue(jsi::Runtime& rt, double tag, double initial);
  void motionInterpolate(jsi::Runtime& rt, double tag, double input, std::vector<double> from, std::vector<double> to);
  void motionSet(jsi::Runtime& rt, double tag, double value);
  void motionStop(jsi::Runtime& rt, double tag);
  void motionFrames(jsi::Runtime& rt, double tag, std::vector<double> frames, double to, bool loop);
  void motionSpring(jsi::Runtime& rt, double tag, double to, double stiffness, double damping, double mass);
  void motionBind(jsi::Runtime& rt, double view, double prop, double node);
  void motionBindScroll(jsi::Runtime& rt, double scrollView, double value);
};

} // namespace facebook::react
