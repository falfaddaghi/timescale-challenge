CREATE TABLE IF NOT EXISTS "logs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "timestamp" TEXT NOT NULL,
  "level" TEXT NOT NULL CHECK ("level" IN ('debug', 'info', 'warn', 'error')),
  "service" TEXT NOT NULL CHECK (length(trim("service")) > 0),
  "message" TEXT NOT NULL CHECK (length(trim("message")) > 0),
  "attributes" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("attributes") = 1 AND json_type("attributes") = 'object'),
  "attribute_values" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("attribute_values") = 1 AND json_type("attribute_values") = 'object'),
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS "logs_timestamp_id_idx"
  ON "logs" ("timestamp" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "logs_service_timestamp_id_idx"
  ON "logs" ("service", "timestamp" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "logs_level_timestamp_id_idx"
  ON "logs" ("level", "timestamp" DESC, "id" DESC);
