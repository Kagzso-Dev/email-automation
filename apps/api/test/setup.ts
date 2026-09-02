// Minimal env so `src/env.ts` validates in unit tests that import domain code.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.LINK_SIGNING_SECRET ||= "test-link-secret";
// Unit tests never open a DB connection; these only satisfy env validation.
process.env.DB_HOST ||= "localhost";
process.env.DB_PORT ||= "3306";
process.env.DB_NAME ||= "dispatch_test";
process.env.DB_USER ||= "root";
process.env.DB_PASSWORD ||= "";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.PUBLIC_API_URL ||= "http://localhost:4000";
process.env.EMAIL_FROM ||= "Test <test@example.com>";
process.env.EMAIL_SENDER_ADDRESS ||= "1 Test Way, Testville";
