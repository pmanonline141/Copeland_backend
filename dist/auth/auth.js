import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import { sendTransactionalEmail } from "../services/notifications.service.js";
import { passwordResetConfirmationEmail, passwordResetEmail, verificationEmail, welcomeEmail, } from "../services/email-templates.js";
function getFrontendUrl() {
    const configured = process.env.FRONTEND_URL
        ?? process.env.FRONTEND_ORIGINS?.split(',')[0]?.trim()
        ?? process.env.BETTER_AUTH_URL;
    if (!configured)
        throw new Error('FRONTEND_URL or FRONTEND_ORIGINS must be configured for welcome emails');
    return new URL(configured).origin;
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
            await sendTransactionalEmail(passwordResetEmail(user.email, user.name, url));
        },
        onPasswordReset: async ({ user }) => {
            await sendTransactionalEmail(passwordResetConfirmationEmail(user.email, user.name));
        },
    },
    emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
            await sendTransactionalEmail(verificationEmail(user.email, user.name, url));
        },
    },
    databaseHooks: {
        user: {
            create: {
                after: async (createdUser) => {
                    await sendTransactionalEmail(welcomeEmail(createdUser.email, createdUser.name, `${getFrontendUrl()}/login`));
                },
            },
        },
    },
    user: {
        additionalFields: {
            role: { type: "string", required: false, defaultValue: "buyer", input: false }
        }
    }
});
