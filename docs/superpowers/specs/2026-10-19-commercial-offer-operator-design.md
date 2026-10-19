# Assign the commercial's agreed monthly offer

The user wants the existing Stripe integration to use the price negotiated by
the commercial, with no public fixed price. Phone availability remains first.
The native Checkout already consumes immutable `billing_agreed_terms`; only its
trusted operator entry is missing. Keep that consumer and its authority intact.

Add one operator-only CLI, outside the web/worker graph. Accept the actual
Workspace, Stripe environment/account, existing monthly Price ID, agreed EUR
amount in integer cents, and expected current terms revision (zero initially).
Read credentials from the existing protected operator environment, never argv.
Use the existing bounded Stripe transport to authenticate the own account and
read the Price. Check active, correct environment/ID, EUR/exact amount, monthly
interval1, licensed/per_unit, no meter/quantity transformation/custom amount.
Share the monthly Price predicate with Checkout; no independent pricing engine.

After provider reads, use the existing administrator/migration database access
and Workspace lock. Require an active personal Workspace, compare latest scoped
revision, and append exactly one immutable row with revision+1. Identical input
after a committed assignment returns that row; concurrent conflicting input or
a stale expected revision refuses. Never update/delete terms or change an
already-admitted subscription. PostgreSQL's existing trigger remains authority.
No database lock spans a provider request. Unknown COMMIT is reported as unknown,
with no automatic retry; a later explicit identical command can observe the row.

Do not add a sales role, dashboard, migration, runtime write grants, dependency,
automatic catalog creation, Customer/payment, or arbitrary provider destination.
The CLI does not start Checkout. Offline tests use synthetic inputs only and
real disposable PostgreSQL for locking, privileges and immutable insertion.
No real client, commercial amount or Price has been supplied: do not invent
them to claim payment acceptance. Sandbox and live remain distinct.
