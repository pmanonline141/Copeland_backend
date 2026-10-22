# Copeland_backend

## Database setup

Apply the committed migrations before starting the API. Set `MIGRATION_DATABASE_URL`
to the direct PostgreSQL connection (port 5432 for Supabase); keep `DATABASE_URL`
for the running app's pooler connection. Then run:

```sh
npm run db:migrate
npm run dev
```

The server checks for required schema objects at startup and reports when migrations
are pending instead of starting a background expiry job against an outdated schema.

## Local email delivery

To send signup verification and other transactional emails through Resend locally,
set `RESEND_API_KEY` to a real Resend API key and set
`RESEND_SEND_IN_DEVELOPMENT=true` in `.env`. For testing before verifying a sending
domain, use `Copeland <onboarding@resend.dev>` as `RESEND_FROM_EMAIL` and send only
to the email address associated with your Resend account. Once a domain is verified,
use a sender address on that domain. Restart the dev server after changing `.env`.

The API logs each request's method, path, status, and duration, and logs the Resend
response status and message ID (or a sanitized error). Request/response bodies,
email addresses, authorization headers, and verification tokens are not logged.
