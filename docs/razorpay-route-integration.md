# Razorpay Route Test integration

Aman confirmed Razorpay Route on 13 October 2026. This selects the transfer
provider; it does not prove account activation, linked-beneficiary onboarding,
bank verification, or live funds readiness. Existing checkout remains TEST.

## Provider-backed diagnostic (15 October 2026)

Ajay authorised one simulated INR 10 payment, held INR 1 transfers to the two
confirmed Test Linked Accounts, both reversals and a full refund. All completed
against the actual Test API and official mock-bank checkout: payment captured,
both transfers processed while held, both fully reversed, one INR 10 refund
processed and the source payment refunded. The callback signature and exact
API amounts/order/recipient identities were checked.

No Live keys, real charge, bank payout, hold release or Firestore write occurred.
The durable diagnostic journal is ignored local output; it prevents a repeated
completion check from creating another payment. Actual IDs, screenshots and
fixture-login instructions must not be published.

Correction: an `acc_prd_...` ID is needed for product-configuration lookup,
**not** payment transfers to dashboard-created `acc_...` Linked Accounts. No
support call is required merely to discover one. Account lookup alone does not
certify transfers; the completed diagnostic proves the bounded Test capability
for this confirmed pair, not Live settlement or real beneficiary eligibility.

## Implemented backend

- `functions/razorpay-route-test-provider.js` supports read-only linked account
  and product checks, payment transfer lookup, transfer lookup, explicitly held
  INR transfers, reversal/refund requests and settlement-hold changes. History
  reads are paginated; it rejects Live keys and sanitises provider diagnostics.
- Account-only readiness deliberately stays unproven. Product checks are
  optional; no personal/KYC/bank fields are exposed by the readiness command.
- A processed transfer is not a settled bank credit. The transfer must also have
  a matching processed recipient settlement. Partial/full reversals remain
  distinct from bank settlement and tenant refunds.
- `scripts/verify-razorpay-route-test.cjs` reads the existing Firebase Test secrets
  privately and checks a specified Linked Account/product without provider writes.
- Broker earnings now require explicit `recipientUid` and `kind: brokerage`.
  Being a participant in an owner's payout is not a broker earning.

`functions/route-test-payouts.js` implements seven admin-only Test callables:
`prepareRouteTestPayout`, `readRouteTestPayout`, `sendRouteTestPayout`,
`reconcileRouteTestPayout`, `releaseRouteTestPayout`, `reverseRouteTestPayout` and
`refundRouteTestPayment`. Plans freeze the signed revision, explicit contract fee,
owner shares, approved repairs and source budget. Reservations prevent repeated
or over-allocated batches. Unknown/partial responses reconcile actual gateway
facts without repeating a transfer, reversal or refund POST. An operation note
is a reconciliation reference, not a provider idempotency guarantee.

`razorpayRouteTestWebhook` verifies signed raw bytes, deduplicates events and
reconciles actual provider state. Saved indexes allow recipient-settlement
events without operation notes to find their plans. Pending transfers remain
processing even with a hold set. Only a matching processed recipient settlement
can produce a bank-settled state.

Full Test cancellation requires every source allocation to be reversed. Refunds
lock the affected bookkeeping for reconciliation; historical paid months and
deposit are not silently erased. The added checkout lock in `rent-payments.js`
also needs a separately scoped refresh of the existing rent callables: deploying
only the eight Route functions does not update those older function revisions.

Ajay authorised deployment limited to these eight new functions. The handoff
records the eight ACTIVE runtimes and their verified application-auth guards.
The CLI's invoker IAM binding failed under domain-restricted sharing. With Ajay's
subsequent scoped authorisation, only these eight services use public HTTPS
entry with the Cloud Run Invoker IAM check disabled; Firebase admin checks and
raw webhook signature verification remain enforced. Organisation policy and
each service's code/runtime spec were left unchanged. Both canonical Functions
and Cloud Run URLs passed unauthenticated/unsigned denial checks. Future releases
must preserve/reverify this boundary rather than weaken organisation policy.
See [Google's public-entry guidance](https://docs.cloud.google.com/run/docs/authenticating/public).
No automatic payout job, Hosting publication,
phone update or provider webhook registration is included. Both transfer flags
remain disabled; enabling app-driven Test transfers needs a separate reviewed
configuration operation.

## Confirmed Test identity mappings (15 October 2026)

Ajay explicitly confirmed one existing Test Linked Account for the designated
broker fixture and one for the owner fixture. Both were fetched successfully
using the existing private Test keys. The matching Firebase identities, roles,
broker approval and configured fictional-phone status were checked again.
Provider contact numbers differ; the override is approved for these tests only,
not for real beneficiaries or Live Mode.

The pair is saved under `serverConfig/razorpayRouteTest` in project `trustkeyper`,
using Firebase UIDs rather than client-editable profile fields. The single
transactional configuration record has `mode: test`, `transfersEnabled: false`,
`liveTransfersEnabled: false` and `status: pending_product_verification`.
Each beneficiary's product configuration ID is unset and its verification flag
is false. A repeated operation verifies the same mapping without overwriting it.
The deployed Firestore rules match local rules. Five role-based emulator tests
cover denied reads, lists, creates, updates and deletes for the configuration
and private plans, source reservations, repair/brokerage claims, transfer
indexes, reversal journals, move-in gates and webhook journals, including admin.

The stored `pending_product_verification` status is historical; it was not
rewritten by the diagnostic. Customer profiles/Auth and provider account/product
configuration remain unchanged. All 278 backend and 56 complete emulator tests
pass, including 39 focused payment/Route unit checks. This is not whole-application payment acceptance. Actual
IDs, fixture-login instructions and operational evidence stay local.

## Approved money rules to preserve

The product/user journey says the first tenant payment contains only the current
rental month, deposit and maintenance; advance months are allowed afterwards
through the agreement end. Deposit is held by TrustKeyper, not paid as owner rent.
The owner's contractual fee is 5–20%; 5% is an example, not a universal default.
Owner rent is paid on the 7th after contractual fee and approved repairs.
Brokerage is held until signing and reaches the bank about two days after move-in.
Keys require every tenant's first rent and deposit. Move-out deposit refunds
follow agreed deductions and unpaid bills; disputed deductions are reviewed.

The final service must not infer equal co-owner payouts or fund brokerage from
the deposit/first tenant invoice: that invoice excludes brokerage. An explicit
approved beneficiary allocation and brokerage collection source are necessary.
Any existing captured/paid record without a valid external signed copy remains
ineligible for automatic release.

## Remaining integration and acceptance

1. Wire the approved admin UI to the new operations and show held, partial,
   unknown, settled, reversed and refunded states accurately. Existing admin
   payout actions remain request metadata, not money movement.
2. Produce verified private initial-payment/actual-move-in gates from operational
   workflows; do not seed success flags simply to release money.
3. Complete separately verified brokerage collection and real beneficiary
   onboarding. Never reuse the testing-only contact override for real users.
4. Complete approved partial move-out/deposit refund accounting, balances and
   dispute/deduction review. Full Test cancellation is not that production flow.
5. Register and accept the provider webhook under separate configuration approval.
6. Obtain business/compliance sign-off and separately test Live capability
   before real-money launch. Do not create a Linked Account or accept terms
   on a real person's behalf merely because their uploaded bank file exists.

## Read-only readiness command

`node scripts/verify-razorpay-route-test.cjs --project=trustkeyper --linked-account=acc_ACTUAL_TEST_ID`

Use actual identifiers, not placeholders. Optionally append
`--product=acc_prd_ACTUAL_TEST_ID` only if already known. The account-only command
does not invent an activation result. No secret keys belong in chat.

Official references: [Route integration](https://razorpay.com/docs/payments/route/integration-guide),
[Linked Account lookup](https://razorpay.com/docs/api/payments/route/fetch-with-id),
[product configuration](https://razorpay.com/docs/api/payments/route/fetch-product-config),
[payment transfers](https://razorpay.com/docs/api/payments/route/create-transfers-payments).
