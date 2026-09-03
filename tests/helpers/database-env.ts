/**
 * Point the shared Prisma client at the test database.
 *
 * MUST be the first import of any test whose static import graph reaches
 * `src/lib/db`: that module instantiates the client from `DATABASE_URL` the
 * moment it is evaluated, so setting the variable inside a `before()` hook is
 * too late for anything imported at the top of the file. Imports are
 * evaluated in order, so importing this module first makes the override
 * happen before any `src/` module loads. Without it a suite gated on
 * `TENANCY_TEST_DATABASE_URL` could silently run against whatever
 * `DATABASE_URL` the shell happens to hold.
 */
if (process.env.TENANCY_TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TENANCY_TEST_DATABASE_URL;
}
export {};
