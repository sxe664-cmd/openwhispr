# Hosted backend removal checklist

This repository contains the desktop client only. When the server repository
is available, remove or disable the following hosted areas:

- Better Auth routes and account/session storage.
- Stripe checkout, billing portal, subscription, usage, entitlement, and plan routes.
- Workspace, team, invitation, membership, sync, sharing, and enterprise-policy routes.
- OpenWhispr Cloud transcription, reasoning, and upload routes if no other client uses them.
- Related database tables, migrations, secrets, webhooks, and deployment environment variables.

The desktop client now treats its local database as the sole source of truth
for notes, transcripts, folders, and local note spaces.
