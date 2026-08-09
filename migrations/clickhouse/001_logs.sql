CREATE TABLE IF NOT EXISTS "logs" (
  "id" UUID,
  "timestamp" DateTime64(3, 'UTC'),
  "level" LowCardinality(String),
  "service" LowCardinality(String),
  "message" String,
  "attributes" String DEFAULT '{}',
  -- The normalized copy makes exact string comparisons consistent for
  -- strings, numbers, and booleans without reparsing JSON at query time.
  "attribute_values" String DEFAULT '{}',
  "created_at" DateTime64(3, 'UTC') DEFAULT now64(3),
  INDEX "logs_message_bloom_idx" "message" TYPE tokenbf_v1(1024, 3, 0) GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toYYYYMM("timestamp")
ORDER BY ("timestamp", "id");

