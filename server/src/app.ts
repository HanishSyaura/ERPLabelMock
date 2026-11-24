import cookieParser from "cookie-parser";
import express, { Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Deps } from "./deps";
import { ok } from "./lib/http";
import { sessionMiddleware } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { auditRoutes } from "./modules/audit/audit.routes";
import { authRoutes } from "./modules/auth/auth.routes";
import { bomRoutes } from "./modules/bom/bom.routes";
import { productRoutes } from "./modules/bom/product.routes";
import { bomFileRoutes } from "./modules/bom/files.routes";
import { materialRoutes } from "./modules/bom/materials.routes";
import { dieCutRoutes } from "./modules/masterdata/die-cuts.routes";
import { partTaxonomyRoutes } from "./modules/masterdata/parts.routes";
import { qcMasterRoutes } from "./modules/qc/masters.routes";
import { qcRoutes } from "./modules/qc/qc.routes";
import { dashboardRoutes } from "./modules/documents/dashboard.routes";
import { documentRoutes } from "./modules/documents/documents.routes";
import { planningMasterRoutes } from "./modules/planning/masters.routes";
import { materialMovementRoutes, planningOpsRoutes } from "./modules/planning/material.routes";
import { orderRoutes } from "./modules/planning/orders.routes";
import { routineRoutes } from "./modules/shopfloor/routines.routes";
import { shopfloorRoutes } from "./modules/shopfloor/shopfloor.routes";
import { roleRoutes } from "./modules/roles/roles.routes";
import { userRoutes } from "./modules/users/users.routes";

export const API_BASE_PATH = "/api/v1";

/**
 * Builds the Express app for both the server and the tests.
 * Feature routers are mounted in FEATURE_ROUTES; every route sits under /api/v1.
 */
export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.set("query parser", "simple");

  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  if (deps.config.NODE_ENV !== "test") {
    app.use(
      pinoHttp({
        logger: deps.logger,
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  if (deps.config.CORS_ORIGINS.length) {
    const allowed = new Set(deps.config.CORS_ORIGINS);
    app.use((req, res, next) => {
      const origin = req.header("origin");
      if (origin && allowed.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Device-Id, X-Request-Id");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  const api = Router();
  api.get("/health", async (_req, res) => {
    await deps.db.$queryRaw`SELECT 1`;
    res.json(ok({ status: "ok", database: "up", time: deps.now().toISOString() }));
  });
  api.use(sessionMiddleware(deps));

  const FEATURE_ROUTES: [string, Router][] = [
    ["/auth", authRoutes(deps)],
    ["/users", userRoutes(deps)],
    ["/roles", roleRoutes(deps)],
    ["/audit", auditRoutes(deps)],
    ["/bom-files", bomFileRoutes(deps)],
    ["/boms", bomRoutes(deps)],
    ["/materials", materialRoutes(deps)],
    ["/parts", partTaxonomyRoutes(deps)],
    ["/die-cuts", dieCutRoutes(deps)],
    ["/products", productRoutes(deps)],
    ["/planning", planningMasterRoutes(deps)],
    ["/planning", orderRoutes(deps)],
    ["/planning", planningOpsRoutes(deps)],
    ["/material", materialMovementRoutes(deps)],
    ["/shopfloor", routineRoutes(deps)],
    ["/shopfloor", shopfloorRoutes(deps)],
    ["/qc", qcMasterRoutes(deps)],
    ["/qc", qcRoutes(deps)],
    ["/documents", documentRoutes(deps)],
    ["/dashboard", dashboardRoutes(deps)],
  ];
  for (const [path, router] of FEATURE_ROUTES) api.use(path, router);

  api.use(notFoundHandler);
  app.use(API_BASE_PATH, api);
  app.use(errorHandler(deps.logger));
  return app;
}
