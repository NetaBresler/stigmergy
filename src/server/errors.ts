/**
 * A handler-level error that carries an HTTP status and a stable machine code.
 * The router turns it into a JSON `{ error: { code, message } }` envelope.
 * Anything else thrown becomes a 500 with a generic message (details logged,
 * never leaked to the wire).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}
