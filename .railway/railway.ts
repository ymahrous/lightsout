// Railway deployment for Lights Out Mafia: one game server and PostgreSQL.
//
//   railway login && railway init      once: sign in and create the project
//   railway config plan                preview what would change
//   railway config apply               create or update the two services
//   railway up --service web           build the Dockerfile and deploy it
//   railway domain --service web       give the game a public address
//
// Step-by-step instructions, and a no-tools route through the dashboard, are in
// docs/DEPLOY-RAILWAY.md. This file replaces railway.json, which Railway stops
// reading on 2026-12-01.
import { defineRailway, postgres, project, service } from "railway/iac";

export default defineRailway(() => {
  // Where rooms live. The only service that holds anything you cannot lose.
  const db = postgres("Postgres");

  const web = service("web", {
    // To redeploy on every push, add `github` to the import above and uncomment:
    // source: github("your-name/lights-out-mafia"),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },

    // A new deployment only takes traffic once it can reach PostgreSQL.
    healthcheck: "/readyz",
    healthcheckTimeout: 60,

    // Keep this at 1. With more copies, a move made on one reaches players on another only
    // through the 5-second resync, so tables split across copies feel laggy.
    replicas: 1,

    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // On a redeploy the old server gets SIGTERM, tells its players to reconnect, and has
      // ten seconds to finish. Rooms live in PostgreSQL, so nobody loses their seat.
      overlapSeconds: 5,
      drainingSeconds: 10,
    },

    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Railway's edge puts the player's real address in this header.
      TRUST_PROXY: "x-real-ip",
    },
  });

  return project("lights-out-mafia", { resources: [web, db] });
});
