// Minimal env so `src/env.ts` validates in unit tests that import domain code.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.LINK_SIGNING_SECRET ||= "test-link-secret";
process.env.DATABASE_URL ||= "postgresql://dispatch:dispatch@localhost:5432/dispatch_test?schema=public";
process.env.REDIS_URL ||= "redis://localhost:6379";
process.env.PUBLIC_API_URL ||= "http://localhost:4000";
process.env.EMAIL_FROM ||= "Test <test@example.com>";
process.env.EMAIL_SENDER_ADDRESS ||= "1 Test Way, Testville";
