# CAD Mouse MK2 Companion

Cross-platform Tauri companion app for testing and tuning the CAD Mouse MK2.

## Current prototype

**WIP — simulator-tested only.** No physical mouse hardware has been connected
or validated yet. HID discovery, live device streaming, and on-device profile
writes remain pending hardware testing.

The app is useful without hardware. Select a deterministic simulator scenario
to drive six live axis traces, drag the 3D cube independently, and inspect idle
drift, smooth sweeps, step response, or noise. The Sensitivity curves view
previews an exponent transfer function and lets you edit gain, dead zone, and
exponent values. Export the resulting JSON and copy it into a firmware profile.

```sh
npm install
npm run dev
```

The desktop shell is initialized under `src-tauri/`. HID discovery and runtime
configuration will be implemented in its Rust backend; the simulator remains
the default so UI work is testable before the physical mouse arrives.

## Planned device workflow

1. Discover the connected mouse and read firmware version/profile.
2. Stream HID axes into the cube and six-axis traces.
3. Send temporary runtime tuning values without overwriting the daily profile.
4. Commit or discard settings on the device.
5. Export a validated profile JSON for the firmware repository.

## Build

```sh
npm run build
cargo tauri build
```
