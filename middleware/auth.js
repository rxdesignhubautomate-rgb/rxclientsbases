import { config } from "../config.js";
import { cleanDeviceCode, getDevice } from "../services/deviceStore.js";

export function requireDashboardKey(req, res, next) {
  if (config.deviceApprovalEnabled) {
    return next();
  }

  const expectedKey = String(config.dashboardApiKey || process.env.DASHBOARD_API_KEY || "").trim();

  const providedKey = String(
    req.headers["x-dashboard-key"] ||
    req.headers["x-api-key"] ||
    req.query.apiKey ||
    req.body?.apiKey ||
    ""
  ).trim();

  if (!expectedKey) {
    return res.status(500).json({
      ok: false,
      error: "DASHBOARD_API_KEY is not set on server"
    });
  }

  if (!providedKey) {
    return res.status(401).json({
      ok: false,
      error: "Dashboard key required"
    });
  }

  if (providedKey !== expectedKey) {
    return res.status(401).json({
      ok: false,
      error: "Invalid dashboard key"
    });
  }

  next();
}

export async function requireApprovedDevice(req, res, next) {
  try {
    if (!config.deviceApprovalEnabled) {
      return next();
    }

    const code = cleanDeviceCode(req.headers["x-device-code"] || req.query.deviceCode || req.body?.deviceCode);
    if (!code) {
      return res.status(403).json({
        ok: false,
        error: "Device code required"
      });
    }

    if (isAdminBootstrapDevice(code)) {
      req.device = { code, role: "admin", approved: true, bootstrap: true };
      return next();
    }

    const device = await getDevice(code);
    if (!device?.approved) {
      const headerRole = cleanSalesRole(req.headers["x-device-role"]);
      const headerUser = cleanSalesRole(req.headers["x-device-user"]);
      const salesRole = headerRole || headerUser;
      if (salesRole) {
        req.device = {
          code,
          role: salesRole,
          approved: true,
          approvedBy: "sales-login-header",
          headerApproved: true
        };
        return next();
      }

      return res.status(403).json({
        ok: false,
        error: "Device not approved",
        deviceCode: code
      });
    }

    req.device = device;
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAdminDevice(req, res, next) {
  try {
    if (!config.deviceApprovalEnabled) {
      return next();
    }

    const code = cleanDeviceCode(req.headers["x-device-code"] || req.query.deviceCode || req.body?.deviceCode);
    if (isAdminBootstrapDevice(code)) {
      req.device = { code, role: "admin", approved: true, bootstrap: true };
      return next();
    }

    const device = await getDevice(code);
    if (!device?.approved || device.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "Admin device approval required",
        deviceCode: code
      });
    }

    req.device = device;
    next();
  } catch (error) {
    next(error);
  }
}

function isAdminBootstrapDevice(code) {
  return Boolean(code && config.adminDeviceCodes.includes(cleanDeviceCode(code)));
}

function cleanSalesRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return config.salesTeam.includes(role) ? role : "";
}
