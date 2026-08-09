import {
  LOG_LEVELS,
  type BatchValidationResult,
  type LogAttributes,
  type LogInput,
  type LogLevel,
  type LogRecord,
  type MalformedBatch,
} from "./log";
import { createLogRecord } from "./log";

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

export class InputValidationError extends Error {
  public readonly statusCode = 400;

  public constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);

/**
 * Parse the restricted ISO-8601 shape accepted by the public API. Keeping
 * this check here (rather than relying on Date.parse's permissive grammar)
 * gives clients deterministic 400 responses across Node versions.
 */
export function parseIsoTimestamp(value: unknown, fieldName = "timestamp"): string {
  if (typeof value !== "string") {
    throw new InputValidationError(`${fieldName} must be a valid ISO 8601 timestamp`);
  }

  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) {
    throw new InputValidationError(`${fieldName} must be a valid ISO 8601 timestamp`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay =
    month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))
      ? 29
      : DAYS_IN_MONTH[month - 1];
  if (maxDay === undefined || day < 1 || day > maxDay) {
    throw new InputValidationError(`${fieldName} must be a valid ISO 8601 timestamp`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InputValidationError(`${fieldName} must be a valid ISO 8601 timestamp`);
  }

  return parsed.toISOString();
}

const validateAttributes = (value: unknown): LogAttributes => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new InputValidationError("attributes must be a flat object");
  }

  const attributes: LogAttributes = {};
  for (const [key, attribute] of Object.entries(value)) {
    if (typeof attribute === "string") {
      attributes[key] = attribute;
    } else if (typeof attribute === "number" && Number.isFinite(attribute)) {
      attributes[key] = attribute;
    } else if (typeof attribute === "boolean") {
      attributes[key] = attribute;
    } else {
      throw new InputValidationError(`attribute '${key}' must be a string, number, or boolean`);
    }
  }
  return attributes;
};

export interface EntryValidationOptions {
  now?: Date;
}

export function validateLogEntry(value: unknown, options: EntryValidationOptions = {}): LogRecord {
  if (!isRecord(value)) {
    throw new InputValidationError("log entry must be an object");
  }

  const entry = value as Partial<LogInput>;
  const timestamp = parseIsoTimestamp(entry.timestamp);
  const now = options.now ?? new Date();
  if (now.getTime() + FIVE_MINUTES_MS < new Date(timestamp).getTime()) {
    throw new InputValidationError("timestamp cannot be more than 5 minutes in the future");
  }

  if (!isLogLevel(entry.level)) {
    const supplied = typeof entry.level === "string" ? `'${entry.level}'` : String(entry.level);
    throw new InputValidationError(`invalid level: ${supplied}`);
  }

  if (typeof entry.service !== "string" || entry.service.trim().length === 0) {
    throw new InputValidationError("service must be a non-empty string");
  }

  if (typeof entry.message !== "string" || entry.message.trim().length === 0) {
    throw new InputValidationError("message must be a non-empty string");
  }

  return createLogRecord({
    timestamp,
    level: entry.level,
    service: entry.service,
    message: entry.message,
    attributes: validateAttributes(entry.attributes),
  });
}

export function validateBatch(
  body: unknown,
  options: EntryValidationOptions = {},
): BatchValidationResult | MalformedBatch {
  if (!isRecord(body) || !Array.isArray(body.logs)) {
    return { error: "body.logs must be an array" };
  }

  const accepted: LogRecord[] = [];
  const rejected: BatchValidationResult["rejected"] = [];
  for (const [index, value] of body.logs.entries()) {
    try {
      accepted.push(validateLogEntry(value, options));
    } catch (error) {
      const reason = error instanceof InputValidationError ? error.message : "invalid log entry";
      rejected.push({ index, reason });
    }
  }

  return { accepted, rejected };
}
