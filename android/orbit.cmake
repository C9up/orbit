# Link orbit into a React Native app's native library (`appmodules`).
#
#   include(${ORBIT_DIR}/android/orbit.cmake)      # in the app's jni/CMakeLists.txt
#   orbit_link(${CMAKE_PROJECT_NAME})
#
# and register the module in the app's OnLoad.cpp cxxModuleProvider:
#   if (name == NativeOrbit::kModuleName) return std::make_shared<NativeOrbit>(jsInvoker);
#
# The TurboModule spec (specs/NativeOrbit.ts) must be in the app's codegen
# sources so `AppSpecsJSI.h` declares NativeOrbitCxxSpec. The Kotlin sources
# under android/src/main/java belong to the app module. `ream` will do all of
# this for an app once it builds mobile apps.

set(ORBIT_ANDROID_DIR ${CMAKE_CURRENT_LIST_DIR})

function(orbit_link target)
  target_sources(${target} PRIVATE ${ORBIT_ANDROID_DIR}/src/main/cpp/NativeOrbit.cpp)
  target_include_directories(${target} PUBLIC ${ORBIT_ANDROID_DIR}/src/main/cpp)
  add_library(orbit_host STATIC IMPORTED)
  set_target_properties(orbit_host PROPERTIES
    IMPORTED_LOCATION ${ORBIT_ANDROID_DIR}/libs/${ANDROID_ABI}/liborbit_host.a)
  target_link_libraries(${target} orbit_host)
endfunction()
