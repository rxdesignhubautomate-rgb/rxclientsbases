import { ForbiddenError } from "../utils/errors.js";

const elevated = new Set(["OWNER", "ADMIN"]);

export function authorizeRole(...roles) {
  return (req, _res, next) => {
    if (req.auth && (elevated.has(req.auth.role) || roles.includes(req.auth.role))) return next();
    return next(new ForbiddenError());
  };
}

export function authorizePermission(...permissions) {
  return (req, _res, next) => {
    if (req.auth && elevated.has(req.auth.role)) return next();
    const granted = new Set(req.auth?.permissions || []);
    if (permissions.some((permission) => granted.has(permission) || granted.has("*"))) return next();
    return next(new ForbiddenError());
  };
}

export function enforceAssignment(entity) {
  return (req) => {
    if (elevated.has(req.auth.role) || req.auth.role === "SALES_MANAGER") return;
    if (req.auth.role === "SALES" && entity.assignedTo !== req.auth.userId) throw new ForbiddenError();
  };
}
