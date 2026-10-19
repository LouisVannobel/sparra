# Assign a commercial offer

Phone availability remains the delivery priority. There is no public fixed price.
Use this one-shot command only for an actual personal Workspace, an agreed monthly
EUR amount and its existing monthly Stripe Price. No actual client, amount or Price
has been supplied or assigned by this change.

Run the qualified source checkout with Node24.14.0 and its existing frozen
pnpm10.32.1 dependency installation. The command uses the existing protected
operator environment: `MIGRATION_DATABASE_URL`, `STRIPE_API_KEY`,
`STRIPE_ACCOUNT_ID`, `STRIPE_ENVIRONMENT` (`sandbox` or `live`). Credentials never
belong in arguments, shell history, reports or an application response. No
webhook secret, application origin, Customer or Checkout is needed.

Use approved nonsecret values for the following placeholders; do not substitute
synthetic fixtures into a real assignment:

```sh
node scripts/assign-billing-terms.ts \
  --workspace "$WORKSPACE_ID" \
  --environment "$STRIPE_ENVIRONMENT" \
  --account "$STRIPE_ACCOUNT_ID" \
  --monthly-price "$MONTHLY_PRICE_ID" \
  --monthly-amount-cents "$AGREED_EUR_CENTS" \
  --expected-revision "$EXPECTED_REVISION"
```

All six arguments are mandatory and accepted once, as separate flag/value pairs.
Cents are positive decimal integers (no rounding, decimals or exponent notation).
The expected revision is zero for a first assignment; otherwise obtain the latest
revision for exactly this Workspace/environment/account through trusted database
administration. Account/environment must match the protected configuration.

The command verifies its own Stripe account and the active Price using bounded
GETs, then closes provider resources before locking the Workspace. The Price must
match the agreed amount in EUR, licensed monthly billing every one month, per unit,
with no meter, custom amount or quantity transformation. It appends one immutable
revision under the native Workspace lock and trigger. It never creates provider
objects or starts Checkout. Runtime, relay and worker cannot assign terms.

Success prints only the assignment ID, Workspace/environment/account, revision
and `assigned` or `existing` status. Repeating the exact original command observes
the row at expected revision plus one; it does not append another revision. A
competing or stale offer is refused. A newer agreed offer requires the actual
current expected revision. Existing admitted Checkout/subscription conditions
retain their original immutable agreement.

`Billing offer commit unknown; rerun the identical command to observe` means the
database did not acknowledge COMMIT. The command does not replay it automatically.
Retain the original arguments and rerun them explicitly to observe the result;
never increment the expected revision to resolve an uncertain outcome. A
`committed; cleanup failed` diagnostic also requires observation before any new
assignment. Other refusals use constant diagnostics without raw provider/SQL data.

Qualification uses synthetic offline provider peers and disposable PostgreSQL.
It does not establish real-provider payment acceptance, deploy this command or
assign any production commercial offer. Sandbox and live require separate real
records and matching protected credentials.
