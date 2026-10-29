import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load the repo-root .env (if any) without overriding real environment variables.
for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(p)) {
    loadDotenv({ path: p, quiet: true });
    break;
  }
}
