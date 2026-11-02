 import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import * as schema from "../db/schema/index.js";
import { sendTransactionalEmail } from "../services/notifications.service.js";
import {
  passwordResetConfirmationEmail,
  passwordResetEmail,
  verificationEmail,
  welcomeEmail,
} from "../services/email-templates.js";
import { OrderService } from "../services/orders.service.js";

function getFrontendUrl() {
  const configured = process.env.FRONTEND_URL
    ?? process.env.FRONTEND_ORIGINS?.split(',')[0]?.trim()
    ?? process.env.BETTER_AUTH_URL;
  if (!configured) throw new Error('FRONTEND_URL or FRONTEND_ORIGINS must be configured for welcome emails');
  return new URL(configured).origin;
}

const trustedOrigins = (process.env.FRONTEND_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (process.env.FRONTEND_URL && !trustedOrigins.includes(process.env.FRONTEND_URL)) {
  trustedOrigins.push(process.env.FRONTEND_URL);
}

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    }
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendTransactionalEmail({
        ...passwordResetEmail(user.email, user.name, url),
        emailType: 'password_reset',
      });
    },
    onPasswordReset: async ({ user }) => {
      await sendTransactionalEmail({
        ...passwordResetConfirmationEmail(user.email, user.name),
        emailType: 'password_reset_confirmation',
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendTransactionalEmail({
        ...verificationEmail(user.email, user.name, url),
        emailType: 'signup_verification',
      });
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          logger.info({ userId: createdUser.id }, 'Signup account created');
          await sendTransactionalEmail({
            ...welcomeEmail(
              createdUser.email,
              createdUser.name,
              `${getFrontendUrl()}/login`,
            ),
            emailType: 'welcome',
          });
          if (createdUser.emailVerified) {
            await OrderService.linkGuestOrdersToUser(createdUser.id, createdUser.email).catch((err) => {
              logger.error({ err, userId: createdUser.id }, 'Failed to link guest orders on registration');
            });
          }
        },
      },
      update: {
        after: async (updatedUser) => {
          if (updatedUser?.id && updatedUser?.emailVerified) {
            await OrderService.linkGuestOrdersToUser(updatedUser.id, updatedUser.email).catch((err) => {
              logger.error({ err, userId: updatedUser.id }, 'Failed to link guest orders on email verification');
            });
          }
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          if (session?.userId) {
            await OrderService.linkGuestOrdersToUser(session.userId).catch((err) => {
              logger.error({ err, userId: session.userId }, 'Failed to link guest orders on login session creation');
            });
          }
        },
      },
    },
  },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "buyer", input: false }
    }
  },
  
  // --- CRITICAL FIX: ADD TRUSTED ORIGINS HERE ---
  trustedOrigins: [
    "http://localhost:3000",
    "http://localhost:4000",
    "https://copeland.africa",
    "https://www.copeland.africa"
  ],

  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    defaultCookieAttributes: {
      sameSite: "lax", 
      secure: process.env.NODE_ENV === "production",
    },
  },
});
