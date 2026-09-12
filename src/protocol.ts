/** Wire-level contract for the MK2 vendor HID Feature report (report ID 0x10). */
export const CONFIG_REPORT_ID = 0x10;
export const CONFIG_REPORT_BYTES = 64;
export const CONFIG_PROTOCOL_VERSION = 1;
export const COMMAND_RESET = 0x01;
export const COMMAND_SET_AXIS = 0x02;
export const COMMAND_SET_GLOBAL = 0x04;
export const COMMAND_GET_AXIS = 0x03;
export const COMMAND_GET_GLOBAL = 0x05;
export const RESPONSE_MARKER = 0x80;

export type ProtocolAxis = "Tx" | "Ty" | "Tz" | "Rx" | "Ry" | "Rz";
export const protocolAxes: ProtocolAxis[] = ["Tx", "Ty", "Tz", "Rx", "Ry", "Rz"];

export type AxisRuntimeValues = {
  gain: number;
  deadzone: number;
  smoothingTauSeconds: number;
  responseExponent: number;
  sign: 1 | -1;
  enabled: boolean;
};

const axisIndex = (axis: ProtocolAxis) => protocolAxes.indexOf(axis);

function putFloat(view: DataView, offset: number, value: number) {
  view.setFloat32(offset, value, true);
}

/** Encodes the fixed 64-byte SET_AXIS packet consumed by firmware. */
export function encodeSetAxis(axis: ProtocolAxis, values: AxisRuntimeValues): Uint8Array {
  if (!Number.isFinite(values.gain) || values.gain < 0) throw new Error("Invalid gain");
  if (!Number.isFinite(values.deadzone) || values.deadzone < 0) throw new Error("Invalid dead zone");
  if (!Number.isFinite(values.smoothingTauSeconds) || values.smoothingTauSeconds < 0) throw new Error("Invalid smoothing");
  if (!Number.isFinite(values.responseExponent) || values.responseExponent < 1 || values.responseExponent > 8) throw new Error("Invalid response exponent");
  if (values.sign !== 1 && values.sign !== -1) throw new Error("Invalid axis sign");
  const packet = new Uint8Array(CONFIG_REPORT_BYTES);
  const view = new DataView(packet.buffer);
  packet[0] = COMMAND_SET_AXIS;
  packet[1] = axisIndex(axis);
  putFloat(view, 2, values.gain);
  putFloat(view, 6, values.deadzone);
  putFloat(view, 10, values.smoothingTauSeconds);
  putFloat(view, 14, values.responseExponent);
  packet[18] = values.sign === 1 ? 1 : 0xff;
  packet[19] = values.enabled ? 1 : 0;
  return packet;
}

export function encodeReset(): Uint8Array {
  const packet = new Uint8Array(CONFIG_REPORT_BYTES);
  packet[0] = COMMAND_RESET;
  return packet;
}

/** Encodes a global profile field. Float calibration drift uses milli-units. */
export function encodeSetGlobal(field: number, value: number): Uint8Array {
  if (!Number.isFinite(value) || field < 1 || field > 8) throw new Error("Invalid global setting");
  const packet = new Uint8Array(CONFIG_REPORT_BYTES);
  const view = new DataView(packet.buffer);
  packet[0] = COMMAND_SET_GLOBAL;
  packet[1] = field;
  view.setUint32(2, field === 2 ? Math.round(value * 1000) : Math.round(value), true);
  return packet;
}

export function encodeGetAxis(axis: ProtocolAxis): Uint8Array {
  const packet = new Uint8Array(CONFIG_REPORT_BYTES);
  packet[0] = COMMAND_GET_AXIS;
  packet[1] = axisIndex(axis);
  return packet;
}

export function encodeGetGlobal(): Uint8Array {
  const packet = new Uint8Array(CONFIG_REPORT_BYTES);
  packet[0] = COMMAND_GET_GLOBAL;
  return packet;
}

export function decodeAxisResponse(packet: Uint8Array): AxisRuntimeValues {
  if (packet.length < 26 || packet[0] !== 0x81) throw new Error("Invalid axis response");
  const view = new DataView(packet.buffer, packet.byteOffset);
  const sign = packet[24] === 0xff ? -1 : packet[24] === 1 ? 1 : 0;
  if (!sign) throw new Error("Invalid axis response sign");
  return { gain: view.getFloat32(8, true), deadzone: view.getFloat32(12, true), smoothingTauSeconds: view.getFloat32(16, true), responseExponent: view.getFloat32(20, true), sign: sign as 1 | -1, enabled: packet[25] !== 0 };
}

export function decodeGlobalResponse(packet: Uint8Array) {
  if (packet.length < 26 || packet[0] !== 0x82) throw new Error("Invalid global response");
  const view = new DataView(packet.buffer, packet.byteOffset);
  return {
    axisLimit: view.getFloat32(8, true),
    calibrationMaxDrift: view.getFloat32(12, true),
    ledBrightness: packet[16],
    idleSleepTimeoutMs: view.getUint32(17, true),
    telemetryEveryLoops: packet[21],
    i2cTimeoutMs: packet[22],
    sensorReadRetries: packet[23],
    watchdogTimeoutMs: view.getUint16(24, true),
  };
}

export function decodeDeviceInfo(packet: Uint8Array) {
  if (packet.length < 8 || packet[0] !== RESPONSE_MARKER) throw new Error("Invalid device response");
  const profileEnd = packet.indexOf(0, 8);
  const profileBytes = packet.slice(8, profileEnd < 0 ? packet.length : profileEnd);
  return {
    protocolVersion: packet[2],
    firmware: `${packet[3]}.${packet[4]}.${packet[5]}`,
    profile: new TextDecoder().decode(profileBytes),
    status: packet[1],
  };
}
