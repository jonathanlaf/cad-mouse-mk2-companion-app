import { describe, expect, it } from "vitest";
import {
  CONFIG_REPORT_BYTES,
  decodeAxisResponse,
  decodeDeviceInfo,
  encodeSetAxis,
  encodeSetGlobal,
} from "./protocol";

describe("runtime HID protocol", () => {
  it("encodes a fixed-size axis packet with little-endian values", () => {
    const packet = encodeSetAxis("Ry", {
      gain: 18,
      deadzone: 20,
      smoothingTauSeconds: 0.08,
      responseExponent: 1.6,
      sign: -1,
      enabled: true,
    });
    expect(packet).toHaveLength(CONFIG_REPORT_BYTES);
    expect(packet[0]).toBe(0x02);
    expect(packet[1]).toBe(4);
    expect(packet[18]).toBe(0xff);
    expect(packet[19]).toBe(1);
  });

  it("rejects invalid curve values", () => {
    expect(() => encodeSetAxis("Tx", {
      gain: 1, deadzone: 0, smoothingTauSeconds: 0,
      responseExponent: 9, sign: 1, enabled: true,
    })).toThrow("Invalid response exponent");
  });

  it("round-trips an axis response", () => {
    const packet = new Uint8Array(64);
    const view = new DataView(packet.buffer);
    packet[0] = 0x81;
    view.setFloat32(8, 28, true);
    view.setFloat32(12, 16, true);
    view.setFloat32(16, 0.08, true);
    view.setFloat32(20, 1.6, true);
    packet[24] = 1;
    packet[25] = 1;
    expect(decodeAxisResponse(packet)).toMatchObject({ gain: 28, deadzone: 16, sign: 1, enabled: true });
  });

  it("decodes firmware info", () => {
    const packet = new Uint8Array(64);
    packet.set([0x80, 0, 1, 0, 2, 3], 0);
    packet.set(new TextEncoder().encode("daily"), 8);
    expect(decodeDeviceInfo(packet)).toMatchObject({ firmware: "0.2.3", profile: "daily" });
  });

  it("encodes global fields", () => {
    const packet = encodeSetGlobal(2, 1.25);
    expect(packet[0]).toBe(0x04);
    expect(packet[1]).toBe(2);
    expect(new DataView(packet.buffer).getUint32(2, true)).toBe(1250);
  });
});
