// SMOKE TEST v3 — xpay.sh facilitator (no auth, Base mainnet)
// Run with: npx wrangler dev src/smoketest.ts
// Test free: curl -i http://localhost:8787/health
// Test paid: curl -i http://localhost:8787/paid (expect 402 Payment Required)

import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

interface Env {}

const PAY_TO = "0x3F3337295fea3613A5f128a8E834A0dca30f9E9a";
const NETWORK = "eip155:8453"; // Base mainnet
const FACILITATOR_URL = "https://facilitator.xpay.sh";

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      message: "smoke test v3 (xpay) alive",
      timestamp: new Date().toISOString(),
    });
  });

  const facilitatorClient = new HTTPFacilitatorClient({
    url: FACILITATOR_URL,
  });

  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme());

  app.use(
    paymentMiddleware(
      {
        "GET /paid": {
          accepts: {
            scheme: "exact",
            price: "$0.001",
            network: NETWORK,
            payTo: PAY_TO,
          },
          description: "Smoke test paid endpoint",
        },
      },
      resourceServer,
    ),
  );

  app.get("/paid", (c) => {
    return c.json({
      status: "ok",
      message: "if you see this, payment succeeded",
    });
  });

  return app;
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    const app = buildApp();
    return app.fetch(req, env, ctx);
  },
};
