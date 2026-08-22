import { assertDisposableDatabaseUrl } from './test-support/database-safety';

// Vitest loads this before every server test file. Centralising the call means
// a future database suite cannot forget the destructive-database boundary.
assertDisposableDatabaseUrl(process.env.DATABASE_URL);
