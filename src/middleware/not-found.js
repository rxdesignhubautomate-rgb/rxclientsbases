import { NotFoundError } from "../utils/errors.js";

export function notFound(_req, _res, next) {
  next(new NotFoundError("Route"));
}
