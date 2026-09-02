import type { Role } from "@prisma/client";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      user?: { id: string; email: string; role: Role };
      apiKeyId?: string;
    }
  }
}

export {};
