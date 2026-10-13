import { z } from "zod";

// Admin-managed users. Roles mirror the Prisma `Role` enum.
export const USER_ROLES = ["ADMIN", "EDITOR"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** bcrypt only reads the first 72 bytes, so longer passwords are rejected rather than silently truncated. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;

export const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((p) => new TextEncoder().encode(p).length <= PASSWORD_MAX_LENGTH, {
    message: `Password must be at most ${PASSWORD_MAX_LENGTH} bytes`,
  });

export const createUserInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: newPassword,
  role: z.enum(USER_ROLES),
});
export type CreateUserInput = z.infer<typeof createUserInput>;

export const setUserDisabledInput = z.object({ disabled: z.boolean() });

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/** What the API returns for a user — never includes the password hash. */
export interface UserSummary {
  id: string;
  email: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}
