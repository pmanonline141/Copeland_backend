# Copeland Backend Folder Structure

This document summarizes the repository layout and the responsibility of each top-level folder and important file.

## Repository tree

```text
copeland-backend/
├── src/                         # Application source code
│   ├── app.ts                   # Express application configuration and middleware
│   ├── server.ts                # HTTP server entry point
│   ├── auth/                    # Authentication and role definitions
│   ├── config/                  # Runtime configuration and environment parsing
│   ├── db/                      # Database connection, migrations, and schemas
│   ├── http/                    # Shared HTTP response helpers
│   ├── middleware/              # Request authentication, validation, and rate limits
│   ├── routes/                  # API route modules
│   ├── services/                # Business logic and external service integrations
│   ├── types/                   # TypeScript declaration extensions
│   └── validation/              # Zod request and domain validation schemas
├── tests/                       # Automated unit and integration tests
├── drizzle/                     # Generated Drizzle SQL migrations and metadata
├── dist/                        # Compiled build output (generated)
├── docs/                        # Project documentation
├── node_modules/                # Installed dependencies (generated, not source)
├── .git/                        # Git repository metadata
├── .vercel/                     # Local Vercel project metadata
├── .env.example                 # Example environment variable names
├── .env.development.local       # Local development environment values (not committed)
├── package.json                 # Scripts and dependency manifest
├── package-lock.json            # Locked npm dependency versions
├── tsconfig.json                # TypeScript settings for development
├── tsconfig.build.json          # TypeScript settings for production builds
├── drizzle.config.ts            # Drizzle Kit configuration
└── README.md                    # Repository overview
```

## `src/` details

### `src/auth/`

Authentication-related modules, including Better Auth setup and application role definitions.

- `auth.ts` — authentication configuration and handlers.
- `roles.ts` — supported roles and role-based access rules.

### `src/config/`

Centralized application configuration.

- `environment.ts` — reads, validates, and exposes environment variables.

### `src/db/`

Database access and schema definitions.

- `index.ts` — database client and connection setup.
- `migrate.ts` — migration runner.
- `schema/` — Drizzle table definitions, split by domain:
  - `auth.ts` — users, sessions, accounts, and authentication data.
  - `fulfillment.ts` — fulfillment-related records.
  - `orders.ts` — order and order-item data.
  - `partners.ts` — partner, recipient, or supplier data.
  - `payments.ts` — payment and settlement data.
  - `products.ts` — product catalog data.
  - `index.ts` — schema barrel export.

### `src/http/`

Reusable HTTP response formatting helpers.

- `responses.ts` — common success and error response builders.

### `src/middleware/`

Cross-cutting request processing applied before route handlers.

- `auth.ts` — authentication and authorization checks.
- `rate-limits.ts` — request throttling and abuse protection.
- `validation.ts` — request validation middleware.

### `src/routes/`

Express API route modules grouped by business capability.

- `admin.ts` — administrative operations.
- `orders.ts` — order endpoints.
- `partners.ts` — partner endpoints.
- `products.ts` — product endpoints.
- `settlements.ts` — settlement and payout endpoints.
- `webhooks.ts` — inbound webhook endpoints.

### `src/services/`

Business workflows and integrations used by routes.

- `audit.service.ts` — audit-event recording.
- `email-templates.ts` — email content and templates.
- `fulfillment.service.ts` — fulfillment workflows.
- `money.ts` — monetary calculations and formatting.
- `notifications.service.ts` — notification delivery.
- `orders.service.ts` — order business logic.
- `payouts.service.ts` — payout processing and review logic.
- `products.service.ts` — product business logic.
- `supabase-storage.service.ts` — Supabase Storage integration.

### `src/types/`

TypeScript-only type declarations.

- `express.d.ts` — Express request/type extensions.

### `src/validation/`

Reusable Zod schemas for validating request bodies, parameters, and domain inputs.

- `schemas.ts` — shared validation definitions.

## `tests/`

Tests are organized by behavior or module rather than by route folder.

- `email-templates.test.ts` — email template behavior.
- `money.test.ts` — monetary calculation behavior.
- `payout-review.test.ts` — payout review workflows.
- `products.test.ts` — product behavior.
- `roles.test.ts` — role and authorization behavior.

## `drizzle/`

Database migration artifacts generated and managed by Drizzle Kit.

- `0000_*.sql` through `0008_*.sql` — ordered SQL migrations.
- `meta/` — Drizzle snapshots and migration journal used to track schema history.

Do not edit generated migration metadata casually; create a new migration when changing the database schema.

## Root-level scripts

The root contains operational scripts for local setup and data management:

- `create-recipient.ts` — creates a recipient record.
- `make-admin.ts` — promotes or configures an admin account.
- `make-supplier.ts` — configures a supplier account.
- `seed-admin.ts` — seeds an administrator.
- `seed-role-accounts.ts` — seeds role-based accounts.
- `seed-test.ts` — seeds test data.
- `trigger-webhook.ts` — sends or simulates a webhook event.

## Generated and local-only folders

- `node_modules/` is installed by npm and should not be committed.
- `dist/` is generated by the TypeScript build and should be treated as build output.
- `.git/` and `.vercel/` contain local repository/deployment metadata.
- `.env.development.local` contains local environment values and must remain private.
