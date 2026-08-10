CREATE TABLE IF NOT EXISTS "logs" (
  "id" UUID PRIMARY KEY,
  "timestamp" TIMESTAMPTZ NOT NULL,
  "level" VARCHAR NOT NULL CHECK ("level" IN ('debug', 'info', 'warn', 'error')),
  "service" VARCHAR NOT NULL CHECK (length(trim("service")) > 0),
  "message" VARCHAR NOT NULL CHECK (length(trim("message")) > 0),
  "attributes" JSON NOT NULL DEFAULT '{}'::JSON CHECK (json_type("attributes") = 'OBJECT'),
  "attribute_values" JSON NOT NULL DEFAULT '{}'::JSON CHECK (json_type("attribute_values") = 'OBJECT'),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "logs_timestamp_id_idx" ON "logs" ("timestamp", "id");
CREATE INDEX IF NOT EXISTS "logs_service_timestamp_id_idx" ON "logs" ("service", "timestamp", "id");
CREATE INDEX IF NOT EXISTS "logs_level_timestamp_id_idx" ON "logs" ("level", "timestamp", "id");
