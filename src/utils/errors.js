export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(entity = "Resource") {
    super("NOT_FOUND", `${entity} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super("CONFLICT", message, 409);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super("FORBIDDEN", message, 403);
  }
}
