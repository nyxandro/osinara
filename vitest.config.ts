/**
 * Vitest project configuration.
 *
 * Constructs:
 * - Parallel local unit execution when database integration tests are disabled.
 * - Sequential integration execution when files share one disposable PostgreSQL database.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
  },
});
