import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { PlanService, registerPlanRoutes, defaultSources } from "../src/plans";

// Plan routes must survive OpenAPI generation as the server registers swagger with jsonSchemaTransform. No DB needed.
describe("plan routes openapi", () => {
  it("generates OpenAPI for all four plan routes", async () => {
    const config = loadConfig({ DATABASE_URL: "postgres://unused", SESSION_SECRET: "t".repeat(40), LOG_LEVEL: "silent" });
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, { openapi: { info: { title: "t", version: "0" } }, transform: jsonSchemaTransform });
    await registerPlanRoutes(app, { config, service: new PlanService({ pool: null as never, mode: "synthetic", sources: defaultSources() }), resolveOwner: () => "x" });
    await app.ready();
    const doc = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/v1/plans", "/api/v1/plans/{id}", "/api/v1/plans/{id}/revisions", "/api/v1/plans/{id}/timeline"]);
    await app.close();
  });
});
