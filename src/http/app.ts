import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { encodeCursor, parseAggregateQuery, parseLogsQuery } from "../domain/query";
import { InputValidationError, validateBatch } from "../domain/validation";
import type { LogStore } from "../db/store";

export interface LogAppOptions {
  store: LogStore;
  bodyLimit?: number;
  now?: () => Date;
  ready?: boolean;
  logger?: boolean;
}

export interface ManagedFastifyInstance extends FastifyInstance {
  markReady(): void;
  markNotReady(): void;
}

const isMalformedJsonError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY";

const sendValidationError = (reply: FastifyReply, error: unknown): FastifyReply => {
  const message = error instanceof InputValidationError ? error.message : "invalid request";
  return reply.code(400).send({ error: message });
};

export function createApp(options: LogAppOptions): ManagedFastifyInstance {
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? 10 * 1024 * 1024,
    logger: options.logger ?? false,
  }) as unknown as ManagedFastifyInstance;
  let ready = options.ready ?? true;

  app.markReady = (): void => {
    ready = true;
  };
  app.markNotReady = (): void => {
    ready = false;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (isMalformedJsonError(error)) {
      return reply.code(400).send({ error: "malformed JSON" });
    }
    if (error instanceof InputValidationError) {
      return sendValidationError(reply, error);
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal server error" });
  });

  app.get("/health", async (_request, reply) => {
    if (!ready) {
      return reply.code(503).send({ status: "not_ready" });
    }
    try {
      await options.store.ping();
      return reply.code(200).send({ status: "ok" });
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.post("/logs", async (request, reply) => {
    const result = validateBatch(request.body, {
      now: options.now?.() ?? new Date(),
    });
    if ("error" in result) {
      return reply.code(400).send({ error: result.error });
    }

    if (result.accepted.length > 0) {
      try {
        await options.store.insertLogs(result.accepted);
      } catch (error) {
        app.log.error(error);
        return reply.code(500).send({ error: "could not persist logs" });
      }
    }

    return reply.code(result.accepted.length > 0 ? 200 : 400).send({
      accepted: result.accepted.length,
      rejected: result.rejected,
    });
  });

  app.get("/logs", async (request, reply) => {
    try {
      const query = parseLogsQuery(request.query);
      const result = await options.store.queryLogs(query.filters, query.limit, query.cursor);
      return reply.code(200).send({
        logs: result.logs,
        next_cursor: result.nextCursor === null ? null : encodeCursor(result.nextCursor),
      });
    } catch (error) {
      if (error instanceof InputValidationError) {
        return sendValidationError(reply, error);
      }
      app.log.error(error);
      return reply.code(500).send({ error: "could not query logs" });
    }
  });

  app.get("/logs/aggregate", async (request, reply) => {
    try {
      const query = parseAggregateQuery(request.query);
      const buckets = await options.store.aggregateLogs(query);
      return reply.code(200).send({ buckets });
    } catch (error) {
      if (error instanceof InputValidationError) {
        return sendValidationError(reply, error);
      }
      app.log.error(error);
      return reply.code(500).send({ error: "could not aggregate logs" });
    }
  });

  app.addHook("onClose", async () => {
    await options.store.close?.();
  });

  return app;
}
