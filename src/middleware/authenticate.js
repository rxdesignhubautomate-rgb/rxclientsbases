import { COLLECTIONS } from "../config/constants.js";
import { AppError, ForbiddenError } from "../utils/errors.js";

export function createAuthenticate({ auth, store }) {
  return async function authenticate(req, _res, next) {
    try {
      const header = String(req.headers.authorization || "");
      if (!header.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", "Authentication required", 401);
      const token = header.slice(7).trim();
      const decoded = await auth.verifyIdToken(token, true);
      const result = await store.find(COLLECTIONS.users, {
        filters: [["firebaseUid", "==", decoded.uid]],
        limit: 2
      });
      const user = result.items.find((candidate) => candidate.active === true);
      if (!user) throw new ForbiddenError("User is disabled or not provisioned");
      if (decoded.orgId && decoded.orgId !== user.orgId) throw new ForbiddenError("Organization claim mismatch");
      req.auth = {
        firebaseUid: decoded.uid,
        userId: user.userId || user.id,
        orgId: user.orgId,
        role: user.role,
        permissions: user.permissions || []
      };
      req.user = user;
      next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      return next(new AppError("UNAUTHENTICATED", "Invalid or expired authentication token", 401));
    }
  };
}
