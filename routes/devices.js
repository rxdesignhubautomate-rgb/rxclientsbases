import express from "express";
import { approveDevice, getDevice, listDevices, revokeDevice } from "../services/deviceStore.js";

export const devicesRouter = express.Router();

devicesRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ devices: await listDevices() });
  } catch (error) {
    next(error);
  }
});

devicesRouter.get("/:code", async (req, res, next) => {
  try {
    const device = await getDevice(req.params.code);
    res.json({ device: device || null });
  } catch (error) {
    next(error);
  }
});

devicesRouter.post("/approve", async (req, res, next) => {
  try {
    const device = await approveDevice({
      code: req.body.code,
      name: req.body.name,
      role: req.body.role,
      approvedBy: req.headers["x-device-user"] || "admin"
    });
    res.json({ ok: true, device });
  } catch (error) {
    next(error);
  }
});

devicesRouter.post("/:code/revoke", async (req, res, next) => {
  try {
    const device = await revokeDevice(req.params.code);
    res.json({ ok: true, device });
  } catch (error) {
    next(error);
  }
});
