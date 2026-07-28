import { getDb } from "../firebase.js";
import { config } from "../config.js";
import { nowIso } from "../utils/time.js";

const DEVICES = "approvedDevices";

export async function listDevices() {
  const db = getDb();
  const snap = await db.collection(DEVICES).orderBy("updatedAt", "desc").limit(200).get();
  const fixedDevices = listFixedDevices();
  const fixedCodes = new Set(fixedDevices.map((device) => device.code));
  const storedDevices = snap.docs
    .map((doc) => ({ code: doc.id, ...doc.data() }))
    .filter((device) => !fixedCodes.has(device.code));
  return [...fixedDevices, ...storedDevices];
}

export async function getDevice(code) {
  const cleaned = cleanDeviceCode(code);
  if (!cleaned) return null;

  const fixedDevice = getFixedDevice(cleaned);
  if (fixedDevice) return fixedDevice;

  const snap = await getDb().collection(DEVICES).doc(cleaned).get();
  return snap.exists ? { code: snap.id, ...snap.data() } : null;
}

export async function approveDevice({ code, name, role, approvedBy }) {
  const cleaned = cleanDeviceCode(code);
  if (!cleaned) {
    throw new Error("Device code is required");
  }

  const device = {
    name: String(name || "Approved device").trim(),
    role: cleanRole(role),
    approved: true,
    approvedBy: String(approvedBy || "admin").trim(),
    approvedAt: nowIso(),
    updatedAt: nowIso()
  };

  await getDb().collection(DEVICES).doc(cleaned).set(device, { merge: true });
  return { code: cleaned, ...device };
}

export async function revokeDevice(code) {
  const cleaned = cleanDeviceCode(code);
  if (!cleaned) {
    throw new Error("Device code is required");
  }
  if (getFixedDevice(cleaned)) {
    throw new Error("This device is fixed in code and cannot be revoked from admin panel");
  }

  await getDb().collection(DEVICES).doc(cleaned).set(
    {
      approved: false,
      revokedAt: nowIso(),
      updatedAt: nowIso()
    },
    { merge: true }
  );

  return { code: cleaned, approved: false };
}

export function cleanDeviceCode(code) {
  return String(code || "").replace(/[^A-Za-z0-9]/g, "").trim().toUpperCase();
}

function listFixedDevices() {
  return config.fixedDevices.map((device) => ({
    code: cleanDeviceCode(device.code),
    name: device.name,
    role: cleanRole(device.role),
    approved: true,
    fixed: true,
    approvedBy: "code",
    approvedAt: "built-in",
    updatedAt: "built-in"
  }));
}

function getFixedDevice(code) {
  const cleaned = cleanDeviceCode(code);
  return listFixedDevices().find((device) => device.code === cleaned) || null;
}

function cleanRole(role) {
  const value = String(role || "sales").trim().toLowerCase();
  const allowed = ["admin", "sales", ...config.salesTeam];
  return allowed.includes(value) ? value : "sales";
}
