// Single place that assembles the MySQL connection URL for Prisma.
//
// Prisma's datasource block requires ONE connection string, but this project
// configures the database with discrete variables:
//
//   DB_HOST  DB_PORT  DB_NAME  DB_USER  DB_PASSWORD
//
// This helper builds `mysql://user:pass@host:port/name` from those. No
// credentials are hardcoded; the password is read from the environment only
// and is never logged.
//
// Backward compatibility: if DATABASE_URL is already set in the environment
// (older deployments, CI overrides), it wins untouched.

export function buildDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL && env.DATABASE_URL.trim()) {
    return env.DATABASE_URL.trim();
  }
  const host = env.DB_HOST || "localhost";
  const port = env.DB_PORT || "3306";
  const name = env.DB_NAME || "dispatch";
  const user = encodeURIComponent(env.DB_USER || "root");
  const password = env.DB_PASSWORD ? `:${encodeURIComponent(env.DB_PASSWORD)}` : "";
  return `mysql://${user}${password}@${host}:${port}/${name}`;
}
