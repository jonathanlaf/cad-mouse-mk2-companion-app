import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { decodeAxisResponse, decodeDeviceInfo, decodeGlobalResponse, encodeGetAxis, encodeGetGlobal, encodeReset, encodeSetAxis, encodeSetGlobal, type AxisRuntimeValues } from "./protocol";
import "./App.css";
import "./layout.css";
import "./fullscreen.css";
import "./cube-options.css";

type Axis = "Tx" | "Ty" | "Tz" | "Rx" | "Ry" | "Rz";
type Sample = { time: number; values: Record<Axis, number> };
const axes: Axis[] = ["Tx", "Ty", "Tz", "Rx", "Ry", "Rz"];
const colors = [
  "#65d9ff",
  "#a88bff",
  "#ffcf70",
  "#ff7f9d",
  "#73e0a2",
  "#ff9f62",
];
const axisInfo: Record<Axis, string> = {
  Tx: "Translation left ↔ right",
  Ty: "Translation forward ↔ back",
  Tz: "Translation up ↔ down",
  Rx: "Rotation around the X axis (pitch)",
  Ry: "Rotation around the Y axis (roll)",
  Rz: "Rotation around the Z axis (twist)",
};
const defaultProfile = {
  name: "companion-tuning",
  version: 1,
  gains: { Tx: 28, Ty: 28, Tz: 24, Rx: 18, Ry: 18, Rz: 20 },
  deadzones: { Tx: 16, Ty: 16, Tz: 16, Rx: 20, Ry: 20, Rz: 20 },
  smoothingTauSeconds: {
    Tx: 0.08,
    Ty: 0.08,
    Tz: 0.08,
    Rx: 0.08,
    Ry: 0.08,
    Rz: 0.08,
  },
  responseExponent: { Tx: 1.6, Ty: 1.6, Tz: 1.6, Rx: 1.6, Ry: 1.6, Rz: 1.6 },
  signs: { Tx: -1, Ty: 1, Tz: -1, Rx: 1, Ry: 1, Rz: 1 },
  enabled: { Tx: true, Ty: true, Tz: true, Rx: true, Ry: true, Rz: true },
  calibrationSamples: 200,
  calibrationSampleIntervalMs: 10,
  calibrationHoldMs: 3000,
  calibrationMaxDrift: 1,
  axisLimit: 350,
  ledBrightness: 40,
  idleSleepTimeoutMs: 120000,
  telemetryEveryLoops: 5,
  i2cTimeoutMs: 25,
  sensorReadRetries: 1,
  watchdogTimeoutMs: 4000,
};

function scenarioValue(s: string, a: Axis, t: number) {
  const p = axes.indexOf(a) * 0.7;
  if (s === "sweep") return Math.sin(t * 1.8 + p) * 260;
  if (s === "steps")
    return (
      (Math.floor((t + p) % 4) < 2 ? 1 : -1) * (a.startsWith("R") ? 150 : 240)
    );
  if (s === "jitter")
    return Math.sin(t * 18 + p) * 10 + Math.sin(t * 2 + p) * 5;
  if (s === "sensor-drift") {
    // Raw sensor offsets: all sensors shift in X (translation), while the
    // top pair diverges in Z (rotation). The resulting axes mirror the
    // firmware's sensor geometry instead of injecting HID values directly.
    const sensor1 = { x: 8, y: 0, z: 0 };
    const sensor2 = { x: 8, y: 0, z: 2 };
    const sensor3 = { x: 8, y: 0, z: -2 };
    const derived: Record<Axis, number> = {
      Tx: (sensor1.x + sensor2.x + sensor3.x) / 3,
      Ty: 0,
      Tz: 0,
      Rx: (Math.sqrt(3) * (sensor2.z + sensor3.z - 2 * sensor1.z)) / 3,
      Ry: sensor3.z - sensor2.z,
      Rz: 0,
    };
    return derived[a];
  }
  if (s === "drift") {
    const index = axes.indexOf(a);
    return (index % 2 === 0 ? 1 : -1) * (4 + index * 2);
  }
  return 0;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [devicePath, setDevicePath] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("Simulator mode");
  const [deviceInfo, setDeviceInfo] = useState<{ firmware: string; profile: string } | null>(null);
  const [deviceSyncStatus, setDeviceSyncStatus] = useState<"idle" | "syncing" | "synced" | "reset">("idle");
  const [scenario, setScenario] = useState("idle");
  const [simulationRunning, setSimulationRunning] = useState(true);
  const [viewMode, setViewMode] = useState<"perspective" | "isometric">(
    "perspective",
  );
  const [samples, setSamples] = useState<Sample[]>([]);
  const [profile, setProfile] = useState(defaultProfile);
  const [tab, setTab] = useState<"physical" | "curves" | "settings">(
    "physical",
  );
  const [selectedAxis, setSelectedAxis] = useState<Axis>("Tx");
  const [cube, setCube] = useState({ x: 0, y: 0, z: 0 });
  const [cubeView, setCubeView] = useState({ zoom: 1, offset: { x: 0, y: 0 } });
  const [cubeFullscreen, setCubeFullscreen] = useState(false);
  const [viewPlane, setViewPlane] = useState("perspective");
  const [opaqueCube, setOpaqueCube] = useState(false);
  const [draggingCube, setDraggingCube] = useState(false);
  const [panningCube, setPanningCube] = useState(false);
  const dragStart = useRef({ pointerX: 0, pointerY: 0, cubeX: 0, cubeY: 0 });
  useEffect(() => {
    if (!simulationRunning) return;
    const start = performance.now();
    const id = setInterval(() => {
      const t = (performance.now() - start) / 1000;
      const values = Object.fromEntries(
        axes.map((a) => [a, scenarioValue(scenario, a, t)]),
      ) as Record<Axis, number>;
      setSamples((o) => [...o.slice(-119), { time: t, values }]);
      if (!draggingCube) {
        if (scenario === "sensor-drift") {
          setCube((current) => ({
            x: current.x + values.Rx * 0.05,
            y: current.y + values.Ry * 0.05,
            z: current.z + values.Rz * 0.05,
          }));
        } else {
          setCube({
            x: values.Rx * 0.18,
            y: values.Ry * 0.18,
            z: values.Rz * 0.18,
          });
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [scenario, simulationRunning, draggingCube]);
  const latest = samples.at(-1)?.values;
  const curvePoints = useMemo(
    () => Array.from({ length: 41 }, (_, i) => i / 40),
    [],
  );
  const update = (key: string, value: unknown) =>
    setProfile((current) => ({ ...current, [key]: value }));
  const applyAxisToAll = (axis: Axis) => {
    const all = <T,>(value: T) => ({
      Tx: value,
      Ty: value,
      Tz: value,
      Rx: value,
      Ry: value,
      Rz: value,
    });
    setProfile((current) => ({
      ...current,
      gains: all(current.gains[axis]),
      deadzones: all(current.deadzones[axis]),
      smoothingTauSeconds: all(current.smoothingTauSeconds[axis]),
      responseExponent: all(current.responseExponent[axis]),
      signs: all(current.signs[axis]),
      enabled: all(current.enabled[axis]),
    }));
    const current = profile;
    axes.forEach((target) => {
      void syncAxis(target, {
        gain: current.gains[axis],
        deadzone: current.deadzones[axis],
        smoothingTauSeconds: current.smoothingTauSeconds[axis],
        responseExponent: current.responseExponent[axis],
        sign: current.signs[axis] as 1 | -1,
        enabled: current.enabled[axis],
      });
    });
  };
  const syncAxis = async (axis: Axis, values: AxisRuntimeValues) => {
    if (!devicePath) return;
    setDeviceSyncStatus("syncing");
    try {
      await invoke("set_hid_feature", {
        path: devicePath,
        payload: Array.from(encodeSetAxis(axis, values)),
      });
      setDeviceSyncStatus("synced");
    } catch {
      setDeviceSyncStatus("idle");
      alert("The device rejected the runtime setting update.");
    }
  };
  const syncProfile = async () => {
    if (!devicePath) return;
    await Promise.all(axes.map((axis) => syncAxis(axis, {
      gain: profile.gains[axis],
      deadzone: profile.deadzones[axis],
      smoothingTauSeconds: profile.smoothingTauSeconds[axis],
      responseExponent: profile.responseExponent[axis],
      sign: profile.signs[axis] as 1 | -1,
      enabled: profile.enabled[axis],
    })));
    const globals: Array<[number, number]> = [
      [1, profile.axisLimit], [2, profile.calibrationMaxDrift],
      [3, profile.ledBrightness], [4, profile.idleSleepTimeoutMs],
      [5, profile.telemetryEveryLoops], [6, profile.i2cTimeoutMs],
      [7, profile.sensorReadRetries], [8, profile.watchdogTimeoutMs],
    ];
    await Promise.all(globals.map(([field, value]) => invoke("set_hid_feature", {
      path: devicePath,
      payload: Array.from(encodeSetGlobal(field, value)),
    })));
  };
  const resetDeviceTuning = async () => {
    if (!devicePath) return;
    try {
      await invoke("set_hid_feature", { path: devicePath, payload: Array.from(encodeReset()) });
      await refreshDeviceAxes(devicePath);
      setDeviceSyncStatus("reset");
    } catch {
      alert("The device rejected the runtime reset.");
    }
  };
  const refreshDeviceAxes = async (path: string) => {
    const values = {} as Record<Axis, AxisRuntimeValues>;
    for (const axis of axes) {
      await invoke("set_hid_feature", { path, payload: Array.from(encodeGetAxis(axis)) });
      const packet = await invoke<number[]>("get_hid_feature", { path });
      values[axis] = decodeAxisResponse(Uint8Array.from(packet));
    }
    setProfile((current) => ({
      ...current,
      gains: Object.fromEntries(axes.map((axis) => [axis, values[axis].gain])) as typeof current.gains,
      deadzones: Object.fromEntries(axes.map((axis) => [axis, values[axis].deadzone])) as typeof current.deadzones,
      smoothingTauSeconds: Object.fromEntries(axes.map((axis) => [axis, values[axis].smoothingTauSeconds])) as typeof current.smoothingTauSeconds,
      responseExponent: Object.fromEntries(axes.map((axis) => [axis, values[axis].responseExponent])) as typeof current.responseExponent,
      signs: Object.fromEntries(axes.map((axis) => [axis, values[axis].sign])) as typeof current.signs,
      enabled: Object.fromEntries(axes.map((axis) => [axis, values[axis].enabled])) as typeof current.enabled,
    }));
    await invoke("set_hid_feature", { path, payload: Array.from(encodeGetGlobal()) });
    const globals = decodeGlobalResponse(Uint8Array.from(await invoke<number[]>("get_hid_feature", { path })));
    setProfile((current) => ({ ...current, ...globals }));
  };
  const selectPlane = (plane: string) => {
    setViewPlane(plane);
    const rotations: Record<string, { x: number; y: number; z: number }> = {
      perspective: { x: 0, y: 0, z: 0 }, front: { x: 0, y: 0, z: 0 }, back: { x: 0, y: 180, z: 0 }, left: { x: 0, y: 90, z: 0 }, right: { x: 0, y: -90, z: 0 }, top: { x: -90, y: 0, z: 0 }, bottom: { x: 90, y: 0, z: 0 },
    };
    if (rotations[plane]) setCube(rotations[plane]);
  };
  const exportProfile = async () => {
    const contents = JSON.stringify(profile, null, 2);
    try {
      const path = await save({
        title: "Export mouse profile",
        defaultPath: `${profile.name || "profile"}.json`,
        filters: [{ name: "JSON profile", extensions: ["json"] }],
      });
      if (path) await writeTextFile(path, contents);
    } catch {
      // Keep the browser/Vite preview useful when it is not running in Tauri.
      const u = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = u;
      a.download = `${profile.name || "profile"}.json`;
      a.click();
      URL.revokeObjectURL(u);
    }
  };
  const importProfile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        setProfile(JSON.parse(String(r.result)));
      } catch {
        alert("Invalid profile JSON");
      }
    };
    r.readAsText(f);
  };
  const connectMouse = async () => {
    if (connected) {
      setConnected(false);
      setDevicePath(null);
      setDeviceLabel("Simulator mode");
      setDeviceInfo(null);
      setDeviceSyncStatus("idle");
      return;
    }
    try {
      const devices = await invoke<Array<{ path: string; product?: string }>>(
        "list_hid_devices",
      );
      const device = devices[0];
      if (!device) {
        alert("No CAD Mouse MK2 HID device found. Simulator remains active.");
        return;
      }
      setDevicePath(device.path);
      setConnected(true);
      setDeviceLabel(device.product || "CAD Mouse MK2");
      try {
        const packet = await invoke<number[]>("get_hid_feature", { path: device.path });
        const info = decodeDeviceInfo(Uint8Array.from(packet));
        setDeviceInfo({ firmware: info.firmware, profile: info.profile });
        setDeviceSyncStatus("synced");
        await refreshDeviceAxes(device.path);
      } catch {
        setDeviceInfo(null);
      }
    } catch {
      alert("Native HID access is unavailable. Simulator remains active.");
    }
  };
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">CAD MOUSE MK2 / COMPANION</span>
          <h1>Hardware lab</h1>
        </div>
        <div className={`connection ${connected ? "online" : ""}`}>
          <i />
          {connected ? "Mouse connected" : deviceLabel}
          <button onClick={connectMouse}>
            {connected ? "Disconnect" : "Connect mouse"}
          </button>
        </div>
      </header>
      <section className="device-bar">
        <div>
          <strong>{connected ? "CAD Mouse MK2" : "Offline test device"}</strong>
          <span>
            {connected
              ? `USB HID · firmware ${deviceInfo?.firmware ?? "unknown"} · profile ${deviceInfo?.profile ?? "unknown"}`
              : "Simulator active · no hardware required"}
            {connected && ` · ${deviceSyncStatus === "syncing" ? "sending…" : deviceSyncStatus === "reset" ? "runtime reset" : "runtime settings synced"}`}
          </span>
        </div>
        <div className="actions">
          <label className="button secondary">
            Import JSON
            <input type="file" accept=".json" onChange={importProfile} />
          </label>
          <button className="button" onClick={exportProfile}>
            Export profile
          </button>
          {connected && <>
            <button className="button secondary" onClick={syncProfile}>
              Send profile to device
            </button>
            <button className="button secondary" onClick={resetDeviceTuning}>
              Reset runtime tuning
            </button>
          </>}
        </div>
      </section>
      <div className="workspace">
        <aside>
          <span className="eyebrow">WORKBENCH</span>
          <button
            className={tab === "physical" ? "nav-selected" : ""}
            onClick={() => setTab("physical")}
          >
            ◈ <span>Physical test</span>
          </button>
          <button
            className={tab === "curves" ? "nav-selected" : ""}
            onClick={() => setTab("curves")}
          >
            ⌁ <span>Curve tuning</span>
          </button>
          <button
            className={tab === "settings" ? "nav-selected" : ""}
            onClick={() => setTab("settings")}
          >
            ⚙ <span>Profile settings</span>
          </button>
          <div className="side-note">
            <span className="eyebrow">PROFILE</span>
            <strong>{profile.name}</strong>
            <small>Unsaved local changes</small>
          </div>
        </aside>
        <article>
          {tab === "physical" && (
            <>
              <section className="toolbar">
                <label>
                  Scenario{" "}
                  <select
                    value={scenario}
                    onChange={(e) => {
                      setScenario(e.target.value);
                      setSimulationRunning(true);
                    }}
                  >
                    <option value="idle">Idle</option>
                    <option value="drift">Output bias</option>
                    <option value="sensor-drift">Sensor drift</option>
                    <option value="sweep">Smooth sweep</option>
                    <option value="steps">Step response</option>
                    <option value="jitter">Noise / jitter</option>
                  </select>
                </label>
                <button
                  className="button secondary"
                  onClick={() => setSimulationRunning(!simulationRunning)}
                >
                  {simulationRunning ? "Stop simulation" : "Start simulation"}
                </button>
                <span className="hint">
                  Synthetic input lets you test the UI before the mouse arrives.
                </span>
              </section>
              <div className="hero-grid">
                <section className={`panel cube-panel ${cubeFullscreen ? "cube-fullscreen" : ""}`}>
                  <div className="panel-title">
                    <div>
                      <span className="eyebrow">ORIENTATION</span>
                      <h2>Physical response</h2>
                    </div>
                    <div className="viewport-tools">
                      <select className="plane-select" value={viewPlane} onChange={(e) => selectPlane(e.target.value)} aria-label="Cube view plane"><option value="perspective">Perspective</option><option value="front">Front</option><option value="back">Back</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option><option value="bottom">Bottom</option></select>
                      <button className="button secondary" onClick={() => setViewMode(viewMode === "perspective" ? "isometric" : "perspective")}>
                        {viewMode === "perspective" ? "Isometric" : "Perspective"}
                      </button>
                      <button className="button secondary" onClick={() => setCubeFullscreen(!cubeFullscreen)}>{cubeFullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
                      <button className="button secondary" onClick={() => setOpaqueCube(!opaqueCube)}>{opaqueCube ? "Transparent sides" : "Opaque sides"}</button>
                    </div>
                  </div>
                  <div
                    className={`cube-stage ${viewMode} ${opaqueCube ? "opaque" : ""}`}
                    onSelect={(e) => e.preventDefault()}
                    onDragStart={(e) => e.preventDefault()}
                    onPointerDown={(e) => {
                      if (e.button !== 0 && e.button !== 1) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setSimulationRunning(false);
                      dragStart.current = {
                        pointerX: e.clientX,
                        pointerY: e.clientY,
                        cubeX: cube.x,
                        cubeY: cube.y,
                      };
                      if (e.button === 1) setPanningCube(true);
                      else setDraggingCube(true);
                    }}
                    onWheel={(e) => {
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pointer = {
                        x: e.clientX - (rect.left + rect.width / 2),
                        y: e.clientY - (rect.top + rect.height / 2),
                      };
                      setCubeView((current) => {
                        const next = Math.min(8, Math.max(0.25, current.zoom - e.deltaY * 0.001));
                        const ratio = next / current.zoom;
                        return { zoom: next, offset: {
                          x: pointer.x - (pointer.x - current.offset.x) * ratio,
                          y: pointer.y - (pointer.y - current.offset.y) * ratio,
                        }};
                      });
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                    onPointerMove={(e) => {
                      if (panningCube)
                        setCubeView((current) => ({
                          ...current,
                          offset: {
                            x: current.offset.x + e.movementX,
                            y: current.offset.y + e.movementY,
                          },
                        }));
                      else if (draggingCube)
                        setCube((current) => ({
                          x: dragStart.current.cubeX - (e.clientY - dragStart.current.pointerY) * 0.7,
                          y: dragStart.current.cubeY + (e.clientX - dragStart.current.pointerX) * 0.7,
                          z: current.z,
                        }));
                    }}
                    onPointerUp={(e) => {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                      setDraggingCube(false);
                      setPanningCube(false);
                    }}
                    onPointerCancel={() => {
                      setDraggingCube(false);
                      setPanningCube(false);
                    }}
                  >
                    <div
                      className="cube"
                      style={{
                        transform: `translate(${cubeView.offset.x}px, ${cubeView.offset.y}px) scale(${cubeView.zoom}) rotateX(${cube.x}deg) rotateY(${cube.y}deg) rotateZ(${cube.z}deg)`,
                      }}
                    >
                      {["front", "back", "right", "left", "top", "bottom"].map(
                        (x) => (
                          <b className={x} key={x}><em>{x.toUpperCase()}</em></b>
                        ),
                      )}
                    </div>
                  </div>
                  <div className="readouts">
                    {axes.map((a) => (
                      <div key={a}>
                        <span>{a}</span>
                        <strong>{(latest?.[a] ?? 0).toFixed(1)}</strong>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <div>
                      <span className="eyebrow">TELEMETRY</span>
                      <h2>Six-axis trace</h2>
                    </div>
                    <span className="units">{connected ? "USB HID" : "SIMULATED"} · ±350 units</span>
                  </div>
                  <div className="charts">
                    {axes.map((a, i) => (
                      <MiniChart
                        key={a}
                        axis={a}
                        samples={samples}
                        color={colors[i]}
                      />
                    ))}
                  </div>
                  <button
                    className="button secondary trace-clear"
                    onClick={() => setSamples([])}
                  >
                    Clear trace
                  </button>
                </section>
              </div>
            </>
          )}
          {tab === "curves" && (
            <CurveView
              profile={profile}
              axis={selectedAxis}
              setAxis={setSelectedAxis}
              update={update}
              applyAxisToAll={applyAxisToAll}
              syncAxis={syncAxis}
              points={curvePoints}
            />
          )}
          {tab === "settings" && <Settings profile={profile} update={update} syncAxis={syncAxis} />}
        </article>
      </div>
      <footer>
        <span>
          Simulator scenarios are deterministic and require no hardware.
        </span>
        <span>
          Runtime HID support will be connected through the Rust backend.
        </span>
      </footer>
    </main>
  );
}

function MiniChart({
  axis,
  samples,
  color,
}: {
  axis: Axis;
  samples: Sample[];
  color: string;
}) {
  const points = samples
    .map((s, i) => `${(i / 119) * 100},${50 - (s.values[axis] / 350) * 46}`)
    .join(" ");
  return (
    <div className="chart">
      <span style={{ color }}>{axis}</span>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path className="zero" d="M0 50H100" />
        <polyline points={points} style={{ stroke: color }} />
      </svg>
    </div>
  );
}
function CurveView({
  profile,
  axis,
  setAxis,
  update,
  applyAxisToAll,
  syncAxis,
  points,
}: {
  profile: typeof defaultProfile;
  axis: Axis;
  setAxis: (a: Axis) => void;
  update: (k: string, v: unknown) => void;
  applyAxisToAll: (a: Axis) => void;
  syncAxis: (a: Axis, values: AxisRuntimeValues) => void;
  points: number[];
}) {
  const exponent = profile.responseExponent[axis];
  return (
    <section className="panel curves">
      <div className="panel-title">
        <div>
          <span className="eyebrow">TRANSFER FUNCTION</span>
          <h2>Shape your sensitivity</h2>
        </div>
        <span className="units">
          {axis} · {axisInfo[axis]}
        </span>
      </div>
      <p className="description">
        The transfer curve maps conditioned input to HID output. The dashed
        line is linear; the colored line applies this axis&apos;s response
        exponent. Gain and dead zone condition the signal before this shape;
        smoothing is temporal and is tuned below as a separate
        latency/stability control.
      </p>
      <div className="curve-layout">
        <svg viewBox="0 0 420 260" aria-label="Sensitivity curve">
          <path
            className="gridline"
            d="M40 220H400M40 140H400M40 60H400M40 220V20M130 220V20M220 220V20M310 220V20M400 220V20"
          />
          <path
            className="curve-line"
            d={points
              .map(
                (x, i) =>
                  `${i ? "L" : "M"}${40 + x * 360},${220 - Math.pow(x, exponent) * 200}`,
              )
              .join(" ")}
          />
          <path className="linear-line" d="M40 220L400 20" />
        </svg>
        <div className="curve-controls">
          <h3>Transfer curve</h3>
          <label>
            Axis
            <select
              value={axis}
              onChange={(e) => setAxis(e.target.value as Axis)}
            >
              {axes.map((a) => (
                <option key={a}>
                  {a} — {axisInfo[a]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary apply-all-axis"
            type="button"
            onClick={() => applyAxisToAll(axis)}
          >
            Apply this axis to all axes
          </button>
          <small className="control-help apply-all-help">
            Copies gain, dead zone, smoothing, curve, direction, and enabled
            state from {axis} to every axis.
          </small>
          <label>
            Exponent <output>{exponent.toFixed(1)}</output>
            <small className="control-help">1.0 is linear. Higher values give finer centre control and require more travel for fast motion.</small>
            <input
              type="range"
              min="1"
              max="3"
              step=".1"
              value={exponent}
              onChange={(e) =>
                (() => {
                  const next = { ...profile, responseExponent: { ...profile.responseExponent, [axis]: Number(e.target.value) } };
                  update("responseExponent", next.responseExponent);
                  syncAxis(axis, { gain: next.gains[axis], deadzone: next.deadzones[axis], smoothingTauSeconds: next.smoothingTauSeconds[axis], responseExponent: next.responseExponent[axis], sign: next.signs[axis] as 1 | -1, enabled: next.enabled[axis] });
                })()
              }
            />
          </label>
          <label>
            Gain <output>{profile.gains[axis]}</output>
            <small className="control-help">Multiplier applied before the HID limit. Raise it when the axis feels too slow.</small>
            <input
              type="range"
              min="1"
              max="60"
              value={profile.gains[axis]}
              onChange={(e) =>
                (() => {
                  const next = { ...profile, gains: { ...profile.gains, [axis]: Number(e.target.value) } };
                  update("gains", next.gains);
                  syncAxis(axis, { gain: next.gains[axis], deadzone: next.deadzones[axis], smoothingTauSeconds: next.smoothingTauSeconds[axis], responseExponent: next.responseExponent[axis], sign: next.signs[axis] as 1 | -1, enabled: next.enabled[axis] });
                })()
              }
            />
          </label>
          <label>
            Dead zone <output>{profile.deadzones[axis]}</output>
            <small className="control-help">Ignores small input around rest to remove sensor drift.</small>
            <input
              type="range"
              min="0"
              max="50"
              value={profile.deadzones[axis]}
              onChange={(e) =>
                (() => {
                  const next = { ...profile, deadzones: { ...profile.deadzones, [axis]: Number(e.target.value) } };
                  update("deadzones", next.deadzones);
                  syncAxis(axis, { gain: next.gains[axis], deadzone: next.deadzones[axis], smoothingTauSeconds: next.smoothingTauSeconds[axis], responseExponent: next.responseExponent[axis], sign: next.signs[axis] as 1 | -1, enabled: next.enabled[axis] });
                })()
              }
            />
          </label>
          <label>
            Smoothing{" "}
            <output>{profile.smoothingTauSeconds[axis].toFixed(2)}s</output>
            <small className="control-help">Low-pass time constant. Higher values reduce jitter but add latency.</small>
            <input
              type="range"
              min="0"
              max=".5"
              step=".01"
              value={profile.smoothingTauSeconds[axis]}
              onChange={(e) =>
                (() => {
                  const next = { ...profile, smoothingTauSeconds: { ...profile.smoothingTauSeconds, [axis]: Number(e.target.value) } };
                  update("smoothingTauSeconds", next.smoothingTauSeconds);
                  syncAxis(axis, { gain: next.gains[axis], deadzone: next.deadzones[axis], smoothingTauSeconds: next.smoothingTauSeconds[axis], responseExponent: next.responseExponent[axis], sign: next.signs[axis] as 1 | -1, enabled: next.enabled[axis] });
                })()
              }
            />
          </label>
          <h3>Time response</h3>
          <p className="field-help">
            {axisInfo[axis]}. Gain controls sensitivity, dead zone removes
            resting drift, smoothing trades latency for stability, and sign
            reverses direction.
          </p>
        </div>
      </div>
    </section>
  );
}
function Settings({
  profile,
  update,
  syncAxis,
}: {
  profile: typeof defaultProfile;
  update: (k: string, v: unknown) => void;
  syncAxis: (a: Axis, values: AxisRuntimeValues) => void;
}) {
  const axisValues = (axis: Axis, changes: Partial<AxisRuntimeValues>): AxisRuntimeValues => ({
    gain: changes.gain ?? profile.gains[axis],
    deadzone: changes.deadzone ?? profile.deadzones[axis],
    smoothingTauSeconds: changes.smoothingTauSeconds ?? profile.smoothingTauSeconds[axis],
    responseExponent: changes.responseExponent ?? profile.responseExponent[axis],
    sign: (changes.sign ?? profile.signs[axis]) as 1 | -1,
    enabled: changes.enabled ?? profile.enabled[axis],
  });
  const field = (
    key: keyof typeof defaultProfile,
    label: string,
    help: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label className="setting">
      <span>
        <strong>{label}</strong>
        <small>{help}</small>
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={profile[key] as number}
        onChange={(e) => update(key, Number(e.target.value))}
      />
    </label>
  );
  return (
    <section className="panel settings">
      <div className="panel-title">
        <div>
          <span className="eyebrow">DEVICE PROFILE</span>
          <h2>Every setting, explained</h2>
        </div>
        <span className="units">Exportable JSON</span>
      </div>
      <div className="settings-grid">
        {field(
          "calibrationSamples",
          "Calibration samples",
          "Samples averaged for the neutral baseline.",
          1,
          1000,
        )}
        {field(
          "calibrationSampleIntervalMs",
          "Calibration interval (ms)",
          "Time between sensor samples.",
          1,
          1000,
        )}
        {field(
          "calibrationHoldMs",
          "Recalibration hold (ms)",
          "Both buttons held to request calibration.",
          100,
          30000,
        )}
        {field(
          "calibrationMaxDrift",
          "Maximum calibration drift",
          "Movement threshold that invalidates a sample window.",
          0.01,
          100,
          0.01,
        )}
        {field(
          "axisLimit",
          "HID axis limit",
          "Maximum report magnitude; firmware supports up to 350.",
          1,
          350,
        )}
        {field(
          "ledBrightness",
          "LED brightness",
          "Ring brightness from 0 to 255.",
          0,
          255,
        )}
        {field(
          "idleSleepTimeoutMs",
          "Idle sleep timeout (ms)",
          "Inactivity before sensor low-power mode.",
          1000,
          3600000,
        )}
        {field(
          "telemetryEveryLoops",
          "Telemetry cadence (loops)",
          "How often diagnostic serial data is emitted.",
          1,
          100,
        )}
        {field(
          "i2cTimeoutMs",
          "I²C timeout (ms)",
          "Upper bound for each sensor bus transaction.",
          1,
          1000,
        )}
        {field(
          "sensorReadRetries",
          "Sensor retries",
          "Extra complete read attempts after a failure.",
          1,
          3,
        )}
        {field(
          "watchdogTimeoutMs",
          "Watchdog timeout (ms)",
          "Active-loop recovery timeout; disabled during sleep.",
          1000,
          8000,
        )}
      </div>
      <div className="axis-settings">
        <div className="axis-settings-title"><span className="eyebrow">PER-AXIS TUNING</span><small>These values are independent for every translation and rotation axis.</small></div>
        {axes.map((axis) => <div className="axis-row" key={axis}>
          <div className="axis-name"><b style={{ color: colors[axes.indexOf(axis)] }}>{axis}</b><small>{axisInfo[axis]}</small></div>
          <label>Gain<input type="number" min="0" max="100" step="0.1" value={profile.gains[axis]} onChange={(e) => { const value = Number(e.target.value); update("gains", { ...profile.gains, [axis]: value }); syncAxis(axis, axisValues(axis, { gain: value })); }} /></label>
          <label>Dead zone<input type="number" min="0" max="350" step="0.1" value={profile.deadzones[axis]} onChange={(e) => { const value = Number(e.target.value); update("deadzones", { ...profile.deadzones, [axis]: value }); syncAxis(axis, axisValues(axis, { deadzone: value })); }} /></label>
          <label>Smoothing (s)<input type="number" min="0" max="1" step="0.01" value={profile.smoothingTauSeconds[axis]} onChange={(e) => { const value = Number(e.target.value); update("smoothingTauSeconds", { ...profile.smoothingTauSeconds, [axis]: value }); syncAxis(axis, axisValues(axis, { smoothingTauSeconds: value })); }} /></label>
          <label>Curve<input type="number" min="1" max="8" step="0.1" value={profile.responseExponent[axis]} onChange={(e) => { const value = Number(e.target.value); update("responseExponent", { ...profile.responseExponent, [axis]: value }); syncAxis(axis, axisValues(axis, { responseExponent: value })); }} /></label>
          <label>Direction<select value={profile.signs[axis]} onChange={(e) => { const value = Number(e.target.value) as 1 | -1; update("signs", { ...profile.signs, [axis]: value }); syncAxis(axis, axisValues(axis, { sign: value })); }}><option value="1">Normal (+)</option><option value="-1">Reversed (−)</option></select></label>
          <label className="axis-enabled">Enabled<input type="checkbox" checked={profile.enabled[axis]} onChange={(e) => { const value = e.target.checked; update("enabled", { ...profile.enabled, [axis]: value }); syncAxis(axis, axisValues(axis, { enabled: value })); }} /></label>
        </div>)}
      </div>
      <div className="axis-summary">
        <span className="eyebrow">AXIS LEGEND</span>
        {axes.map((a) => (
          <div key={a}>
            <b style={{ color: colors[axes.indexOf(a)] }}>{a}</b>
            <span>{axisInfo[a]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
export default App;
