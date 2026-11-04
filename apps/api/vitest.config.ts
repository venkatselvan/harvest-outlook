import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup-shared-memo.ts"], fileParallelism: false, testTimeout: 20000 } });
