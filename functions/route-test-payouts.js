import { createHash, randomUUID } from 'node:crypto';
import { PaymentError, validPaymentSignature } from './rent-payments.js';
import { approvalDigest } from './agreement-approvals.js';
import { reviewSnapshot } from './agreement-review.js';
import { routeTransferState } from './razorpay-route-test-provider.js';

const requireValue = (condition, message, code = 'failed-precondition') => {
  if (!condition) throw new PaymentError(code, message);
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = value => Number.isSafeInteger(value) && value >= 0;
const identifier = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const planPath = id => `routeTestPayoutPlans/${id}`;
const sourcePath = id => `routeTestPayoutSources/${id}`;
const summary = plan => ({ planId: plan.id, paymentId: plan.paymentId, agreementId: plan.agreementId,
  mode: 'test', kind: plan.kind, status: plan.status, scheduledAtMs: plan.scheduledAtMs,
  amountPaise: plan.parts.reduce((total, part) => total + part.amountPaise, 0),
  feePaise: plan.feePaise, repairPaise: plan.repairPaise, depositTransferredPaise: 0,
  parts: plan.parts.map(part => ({ recipientUid: part.uid, role: part.role, amountPaise: part.amountPaise,
    transferId: part.transferId ?? null, status: part.status ?? 'prepared' })),
  refundStatus: plan.refundStatus ?? 'not_requested', lastError: plan.lastError ?? null });

export function createRouteTestPayoutService({ store, provider, auth, now = Date.now, nonce = randomUUID }) {
  async function access(transaction, enabled = false, internal = false) {
    requireValue(provider.mode === 'test', 'Only the Test Route provider is supported.');
    if (!internal) {
      requireValue(auth?.uid, 'Log in to the admin portal.', 'unauthenticated');
      const profile = await transaction.get(`users/${auth.uid}`);
      requireValue(profile?.roles?.includes('admin') && profile.paused !== true,
        'Only the team can manage test transfers.', 'permission-denied');
    }
    const config = await transaction.get('serverConfig/razorpayRouteTest');
    requireValue(config?.mode === 'test' && config.liveTransfersEnabled === false, 'Test Route configuration is unavailable.');
    if (enabled) requireValue(config.transfersEnabled === true, 'Test transfers are disabled. No money was moved.');
    return config;
  }
  async function agreementContext(transaction, payment) {
    requireValue(payment?.mode === 'test' && payment.status === 'paid' && money(payment.amountPaise) && payment.amountPaise > 0,
      'Choose a captured, unreconciled Test receipt.');
    const agreement = await transaction.get(`agreements/${payment.agreementId}`);
    const copy = agreement?.agreementCopy;
    requireValue(agreement?.revision === payment.revision && copy?.revision === payment.revision &&
      ['signed_copy_received', 'active'].includes(agreement.status) && copy.mode === 'externally_signed' &&
      copy.file?.sha256 && copy.attestation?.approvedOriginal === true && copy.attestation?.allPartiesSigned === true &&
      copy.attestation?.matchesReviewedTerms === true, 'An actual matching signed agreement copy is required. Demo copies cannot release funds.');
    const snapshot = reviewSnapshot(agreement);
    requireValue(copy.digest === approvalDigest(snapshot), 'Agreement terms changed. Reconcile the transfer plan first.');
    return { agreement, copy, snapshot };
  }
  async function current(transaction, id, { enabled = false, internal = false, legal = false } = {}) {
    requireValue(/^[a-f0-9]{64}$/.test(id ?? ''), 'Choose a saved Test transfer plan.', 'invalid-argument');
    const config = await access(transaction, enabled, internal);
    const plan = await transaction.get(planPath(id));
    requireValue(plan?.id === id && plan.mode === 'test', 'Test transfer plan not found.', 'not-found');
    if (legal) {
      const payment = await transaction.get(`payments/${plan.paymentId}`);
      const context = await agreementContext(transaction, payment);
      requireValue(context.copy.digest === plan.digest && payment.amountPaise === plan.sourceAmountPaise && payment.orderId === plan.orderId,
        'The signed agreement or receipt changed. Reconciliation is required.');
      for (const part of plan.parts) {
        const binding = Object.values(config.beneficiaries ?? {}).find(value => value.uid === part.uid && value.role === part.role);
        const profile = await transaction.get(`users/${part.uid}`);
        requireValue((part.role === 'owner' ? context.copy.people.some(person => person.role === 'owner' && person.uid === part.uid)
          : context.agreement.brokerUid === part.uid) && binding?.accountId === part.accountId && binding.mode === 'test' &&
          binding.accountLookupVerified === true && profile?.roles?.includes(part.role) && profile.paused !== true &&
          (part.role !== 'broker' || profile.approvalStatus === 'approved'),
        'The beneficiary changed or is paused. Reverify it before any transfer.');
      }
      for (const repair of plan.repairs) {
        const charge = await transaction.get(`repairCharges/${repair.id}`);
        const claim = await transaction.get(`routeTestRepairClaims/${repair.id}`);
        requireValue(charge?.agreementId === plan.agreementId && charge.amountPaise === repair.amountPaise &&
          charge.source === 'verified_repair_completion' && charge.status === 'pending_reconciliation' &&
          charge.completionUploadId === repair.completionUploadId && charge.payoutDateISO === `${plan.month}-07` && claim?.planId === plan.id,
        'An approved repair deduction changed. Reconcile before transferring.');
      }
    }
    return { plan, config };
  }
  async function gatewayPayment(plan, allowRefund = false) {
    const payment = await provider.payment(plan.paymentId);
    requireValue(payment.id === plan.paymentId && payment.entity === 'payment' && payment.order_id === plan.orderId &&
      payment.amount === plan.sourceAmountPaise && payment.currency === 'INR' && payment.captured === true &&
      (payment.status === 'captured' || allowRefund && payment.status === 'refunded') &&
      (allowRefund || (payment.amount_refunded ?? 0) === 0), 'The gateway payment changed. Reconcile before continuing.');
    return payment;
  }
  async function errorState(id, lease, error) {
    return store.transaction(async transaction => {
      const { plan } = await current(transaction, id, { internal: true });
      if (plan.lease !== lease || plan.status !== 'creating') return summary(plan);
      const patch = { status: error.definitive === true ? 'failed' : 'unknown', leaseUntilMs: 0,
        version: plan.version + 1, lastError: error.definitive === true ? 'provider_rejected' : 'check_status_before_retry', updatedAtMs: now() };
      transaction.update(planPath(id), patch);
      return summary({ ...plan, ...patch });
    });
  }
  async function reconcile(id, internal = false, lease = null) {
    const { plan } = await store.transaction(transaction => current(transaction, id, { internal }));
    if (plan.status === 'creating' && plan.leaseUntilMs > now() && plan.lease !== lease) return summary(plan);
    const source = await gatewayPayment(plan, true);
    const transfers = await provider.transfers(plan.paymentId);
    const parts = [];
    for (const part of plan.parts) {
      const matches = transfers.filter(transfer => transfer.notes?.tk_route_operation === part.operationId);
      requireValue(matches.length <= 1, 'Duplicate gateway transfers require team reconciliation.');
      if (!matches.length) { parts.push({ ...part, status: 'not_confirmed' }); continue; }
      const transfer = matches[0];
      requireValue(identifier(transfer.id, 'trf') && transfer.entity === 'transfer' && transfer.source === plan.paymentId &&
        transfer.recipient === part.accountId && transfer.amount === part.amountPaise && transfer.currency === 'INR' &&
        (!part.transferId || part.transferId === transfer.id),
      'Gateway transfer does not match the reserved beneficiary and amount.');
      let settlement = null;
      if (transfer.status === 'processed' && transfer.recipient_settlement_id && !transfer.on_hold) {
        settlement = await provider.settlement(transfer.recipient_settlement_id, part.accountId);
      }
      parts.push({ ...part, transferId: transfer.id, status: routeTransferState(transfer, settlement),
        amountReversedPaise: transfer.amount_reversed ?? 0,
        recipientSettlementId: transfer.recipient_settlement_id ?? null });
    }
    const found = parts.filter(part => part.transferId && part.status !== 'not_confirmed').length;
    const status = found === 0 ? (plan.status === 'prepared' ? 'prepared' : 'unknown')
      : found !== parts.length ? 'partial'
      : parts.every(part => part.status === 'reversed') ? 'reversed'
      : parts.every(part => part.status === 'settled') ? 'settled'
      : parts.every(part => part.status === 'held') ? 'held'
      : parts.some(part => ['failed', 'partially_reversed'].includes(part.status)) ? 'reconciliation_required'
      : 'awaiting_settlement';
    return store.transaction(async transaction => {
      const saved = await current(transaction, id, { internal });
      const payment = await transaction.get(`payments/${plan.paymentId}`);
      const intent = source.amount_refunded > 0 && payment?.intentId
        ? await transaction.get(`rentPaymentIntents/${payment.intentId}`) : null;
      const account = intent?.accountId ? await transaction.get(`rentPaymentAccounts/${intent.accountId}`) : null;
      const savedPayouts = await Promise.all(parts.map(part => transaction.get(`payouts/${part.operationId}`)));
      requireValue(saved.plan.fingerprint === plan.fingerprint && saved.plan.version === plan.version &&
        !(saved.plan.status === 'creating' && saved.plan.leaseUntilMs > now() && saved.plan.lease !== lease),
      'Another operation is in progress. Check status again.', 'aborted');
      const patch = { status, parts, version: saved.plan.version + 1, leaseUntilMs: 0, lastError: found !== parts.length && status !== 'prepared'
        ? 'reconcile_partial_or_unknown_transfer' : null, updatedAtMs: now() };
      transaction.update(planPath(id), patch);
      for (const [index, part] of parts.entries()) {
        if (!part.transferId) continue;
        transaction.set(`routeTestTransferIndex/${part.transferId}`, { planId: id, paymentId: plan.paymentId });
        transaction.set(`payouts/${part.operationId}`, { ...savedPayouts[index], mode: 'test', routeTestPlanId: id,
          agreementId: plan.agreementId, revision: plan.revision, sourcePaymentId: plan.paymentId,
          recipientUid: part.uid, recipientRole: part.role, recipientName: part.name, kind: plan.kind,
          amountPaise: part.amountPaise, status: part.status, scheduledAtMs: plan.scheduledAtMs,
          transferId: part.transferId, participantUids: plan.participantUids, updatedAtMs: now() });
      }
      if (source.amount_refunded > 0 && payment) transaction.update(`payments/${plan.paymentId}`, {
        refundedPaise: source.amount_refunded, status: source.amount_refunded === source.amount ? 'refunded' : 'reconciliation_required',
        settlementStatus: 'test_refund_reconciliation', updatedAtMs: now() });
      if (account) transaction.update(`rentPaymentAccounts/${intent.accountId}`, { reconciliationRequired: true, updatedAtMs: now() });
      return summary({ ...saved.plan, ...patch });
    });
  }
  return {
    async prepare(input) {
      requireValue(identifier(input.paymentId, 'pay') && input.confirmContractTerms === true,
        'Confirm the allocation against the signed agreement.', 'invalid-argument');
      requireValue(input.kind === undefined || input.kind === 'owner_rent' || input.kind === 'brokerage', 'Choose the payout purpose.', 'invalid-argument');
      const kind = input.kind ?? 'owner_rent';
      const id = hash(['route-test', input.paymentId, kind, input.month ?? null]);
      return store.transaction(async transaction => {
        const config = await access(transaction);
        const payment = await transaction.get(`payments/${input.paymentId}`);
        const { agreement, copy, snapshot } = await agreementContext(transaction, payment);
        const existing = await transaction.get(planPath(id));
        const source = await transaction.get(sourcePath(input.paymentId)) ?? { reservedPaise: 0, planIds: [] };
        requireValue(!source.refundOperationId, 'A refund is being reconciled for this payment.');
        let grossPaise, feePaise = 0, repairPaise = 0, scheduledAtMs, shares, brokerageClaim;
        const repairs = [];
        if (kind === 'owner_rent') {
          const line = payment.lines?.find(line => line.month === input.month);
          requireValue(line && /^\d{4}-\d{2}$/.test(input.month) && money(line.rentPaise) &&
            Number.isSafeInteger(input.feeBasisPoints) && input.feeBasisPoints >= 500 && input.feeBasisPoints <= 2000,
          'Choose the captured rental month and its contractual fee between 5% and 20%.', 'invalid-argument');
          grossPaise = line.rentPaise;
          feePaise = Number(BigInt(grossPaise) * BigInt(input.feeBasisPoints) / 10000n);
          const repairIds = input.repairIds ?? [];
          requireValue(Array.isArray(repairIds) && repairIds.length <= 50 && new Set(repairIds).size === repairIds.length &&
            repairIds.every(value => typeof value === 'string' && /^[\w-]{1,150}$/.test(value)), 'Choose distinct saved repair charges.', 'invalid-argument');
          for (const repairId of repairIds) {
            const charge = await transaction.get(`repairCharges/${repairId}`);
            const reservation = await transaction.get(`routeTestRepairClaims/${repairId}`);
            requireValue(charge?.agreementId === payment.agreementId && charge.source === 'verified_repair_completion' &&
              charge.status === 'pending_reconciliation' && charge.payoutDateISO === `${input.month}-07` && money(charge.amountPaise) &&
              typeof charge.completionUploadId === 'string' && charge.completionUploadId.length > 0 &&
              (!reservation || reservation.planId === id), 'A repair charge changed or is reserved by another payout.');
            repairs.push({ id: repairId, amountPaise: charge.amountPaise, completionUploadId: charge.completionUploadId });
            repairPaise += charge.amountPaise;
          }
          scheduledAtMs = Date.parse(`${input.month}-07T00:00:00+05:30`);
          shares = input.ownerShares;
          requireValue(Array.isArray(shares) && shares.length > 0 && shares.length <= 20 &&
            new Set(shares.map(part => part.uid)).size === shares.length &&
            shares.every(part => typeof part.uid === 'string' && Number.isSafeInteger(part.basisPoints) && part.basisPoints > 0 &&
              copy.people.some(person => person.role === 'owner' && person.uid === part.uid)) &&
            shares.reduce((sum, part) => sum + part.basisPoints, 0) === 10000,
          'Enter the explicit signed owner shares totalling 100%. Equal shares are not assumed.', 'invalid-argument');
        } else {
          const funding = await transaction.get(`routeTestBrokerageFunding/${input.paymentId}`);
          brokerageClaim = await transaction.get(`routeTestBrokerageClaims/${hash([payment.agreementId, payment.revision])}`) ?? { reservedPaise: 0 };
          requireValue(payment.purpose === 'brokerage_collection' && funding?.purpose === 'separate_brokerage_collection' &&
            funding.agreementId === payment.agreementId && funding.revision === payment.revision && funding.digest === copy.digest &&
            funding.amountPaise === payment.amountPaise && funding.approved === true && funding.paymentId === input.paymentId &&
            payment.amountPaise <= snapshot.ownerBrokeragePaise + snapshot.tenantBrokeragePaise,
          'Brokerage needs its own verified collection source. Tenant rent and deposits cannot fund it.');
          grossPaise = funding.amountPaise;
          scheduledAtMs = 0;
          shares = [{ uid: agreement.brokerUid, basisPoints: 10000 }];
        }
        const netPaise = grossPaise - feePaise - repairPaise;
        requireValue(netPaise > 0 && money(netPaise), 'Deductions require review; no positive amount is available.');
        const parts = [];
        let assigned = 0;
        for (const [index, share] of shares.entries()) {
          const role = kind === 'brokerage' ? 'broker' : 'owner';
          const binding = Object.values(config.beneficiaries ?? {}).find(value => value.uid === share.uid && value.role === role);
          const profile = await transaction.get(`users/${share.uid}`);
          requireValue(binding?.mode === 'test' && identifier(binding.accountId, 'acc') && binding.accountLookupVerified === true &&
            profile?.roles?.includes(role) && profile.paused !== true && (role !== 'broker' || profile.approvalStatus === 'approved'),
          'Every recipient needs a confirmed, enabled Test beneficiary mapping.');
          const amountPaise = index === shares.length - 1 ? netPaise - assigned : Number(BigInt(netPaise) * BigInt(share.basisPoints) / 10000n);
          requireValue(amountPaise > 0, 'A recipient allocation rounds to zero. Review the split.');
          assigned += amountPaise;
          parts.push({ uid: share.uid, name: profile.displayName ?? role, role, accountId: binding.accountId,
            amountPaise, operationId: `${id}-${index}`, status: 'prepared' });
        }
        const fingerprint = hash([input.paymentId, payment.revision, copy.digest, kind, input.month ?? null,
          input.feeBasisPoints ?? null, shares, repairs, parts.map(part => [part.uid, part.accountId, part.amountPaise])]);
        if (existing) {
          requireValue(existing.fingerprint === fingerprint, 'This captured period already has a different approved plan.', 'aborted');
          return summary(existing);
        }
        if (brokerageClaim) requireValue(money(brokerageClaim.reservedPaise) &&
          brokerageClaim.reservedPaise + grossPaise <= snapshot.ownerBrokeragePaise + snapshot.tenantBrokeragePaise,
        'The agreed brokerage is already reserved by another payment.');
        const budget = kind === 'owner_rent' ? payment.lines.reduce((sum, line) => sum + line.rentPaise, 0) : payment.amountPaise;
        requireValue(money(source.reservedPaise) && source.reservedPaise + grossPaise <= budget && budget <= payment.amountPaise - (payment.depositPaise ?? 0),
          'This payment is already allocated or contains reserved deposit money.');
        const plan = { id, mode: 'test', paymentId: input.paymentId, orderId: payment.orderId,
          agreementId: payment.agreementId, revision: payment.revision, digest: copy.digest,
          sourceAmountPaise: payment.amountPaise, participantUids: agreement.participantUids,
          kind, month: input.month ?? null, feePaise, repairPaise, repairs, scheduledAtMs, parts,
          grossPaise, fingerprint, version: 1, approvedBy: auth.uid, createdAtMs: now(), status: 'prepared' };
        transaction.set(planPath(id), plan);
        transaction.set(sourcePath(input.paymentId), { ...source, reservedPaise: source.reservedPaise + grossPaise,
          planIds: [...source.planIds, id], updatedAtMs: now() });
        for (const repair of repairs) transaction.set(`routeTestRepairClaims/${repair.id}`, { planId: id, amountPaise: repair.amountPaise });
        if (brokerageClaim) transaction.set(`routeTestBrokerageClaims/${hash([payment.agreementId, payment.revision])}`,
          { reservedPaise: brokerageClaim.reservedPaise + grossPaise, updatedAtMs: now() });
        return summary(plan);
      });
    },
    async read({ planId }) {
      return store.transaction(async transaction => summary((await current(transaction, planId)).plan));
    },
    async send({ planId }) {
      const lease = nonce();
      const reservation = await store.transaction(async transaction => {
        const { plan } = await current(transaction, planId, { enabled: true, legal: true });
        const source = await transaction.get(sourcePath(plan.paymentId));
        requireValue(!source?.refundOperationId, 'A refund is being reconciled.');
        if (plan.status !== 'prepared') return { plan, send: false };
        transaction.update(planPath(planId), { status: 'creating', version: plan.version + 1, lease, leaseUntilMs: now() + 60000, updatedAtMs: now() });
        return { plan, send: true };
      });
      if (!reservation.send) return summary(reservation.plan);
      try {
        await gatewayPayment(reservation.plan);
        for (const part of reservation.plan.parts) {
          const account = await provider.linkedAccount(part.accountId);
          requireValue(account.status === 'created', 'A Test Linked Account is suspended or unavailable.');
        }
        await provider.createHeldTransfers(reservation.plan.paymentId, reservation.plan.parts);
        return await reconcile(planId, false, lease);
      } catch (error) { return errorState(planId, lease, error); }
    },
    async reconcile({ planId }) { return reconcile(planId); },
    async release({ planId }) {
      await reconcile(planId);
      const { plan } = await store.transaction(async transaction => {
        const result = await current(transaction, planId, { enabled: true, legal: true });
        const gate = await transaction.get(`routeTestAgreementGates/${result.plan.agreementId}`);
        requireValue(result.plan.status === 'held' && gate?.mode === 'test' && gate.revision === result.plan.revision &&
          gate.digest === result.plan.digest && gate.allTenantsInitialPaymentsVerified === true &&
          gate.physicalMoveInConfirmed === true && Number.isSafeInteger(gate.moveInAtMs) && gate.moveInAtMs <= now(),
        'Verified initial payments and the actual move-in are required before releasing a hold.');
        const due = result.plan.kind === 'brokerage' ? gate.moveInAtMs + 2 * 86400000 : result.plan.scheduledAtMs;
        requireValue(now() >= due, 'The agreed payout date has not arrived.');
        return result;
      });
      await gatewayPayment(plan);
      for (const part of plan.parts) await provider.hold(part.transferId, false);
      return reconcile(planId);
    },
    async reverse({ planId }) {
      await reconcile(planId);
      const { plan } = await store.transaction(transaction => current(transaction, planId, { enabled: true }));
      await gatewayPayment(plan, true);
      for (const part of plan.parts) {
        requireValue(part.transferId, 'Reconcile every transfer before requesting a reversal.');
        const operationId = hash(['reverse', part.operationId]);
        const claimed = await store.transaction(async transaction => {
          await access(transaction, true);
          const previous = await transaction.get(`routeTestReversalOperations/${operationId}`);
          if (previous) return false;
          transaction.set(`routeTestReversalOperations/${operationId}`, { planId, transferId: part.transferId, status: 'started', createdAtMs: now() });
          return true;
        });
        if (!claimed) continue;
        try {
          const transfer = await provider.transfer(part.transferId);
          requireValue(transfer.id === part.transferId && transfer.source === plan.paymentId && transfer.recipient === part.accountId &&
            transfer.amount === part.amountPaise && transfer.currency === 'INR', 'The reversal destination does not match the saved transfer.');
          routeTransferState(transfer);
          const remaining = part.amountPaise - (transfer.amount_reversed ?? 0);
          if (remaining > 0) await provider.reverse(part.transferId, remaining, operationId);
        } catch (error) {
          await store.transaction(async transaction => transaction.update(`routeTestReversalOperations/${operationId}`,
            { status: 'unknown', updatedAtMs: now() }));
          throw error;
        }
      }
      const result = await reconcile(planId);
      await store.transaction(async transaction => {
        for (const part of result.parts.filter(part => part.status === 'reversed')) {
          const savedPart = plan.parts.find(value => value.transferId === part.transferId);
          transaction.update(`routeTestReversalOperations/${hash(['reverse', savedPart.operationId])}`,
            { status: 'reversed', updatedAtMs: now() });
        }
      });
      return result;
    },
    async refund({ planId, confirmFullTestCancellation }) {
      requireValue(confirmFullTestCancellation === true, 'Confirm this is a full Test payment cancellation.', 'invalid-argument');
      const { plan } = await store.transaction(transaction => current(transaction, planId, { enabled: true }));
      const source = await store.transaction(async transaction => {
        await access(transaction, true);
        return transaction.get(sourcePath(plan.paymentId));
      });
      for (const id of source.planIds) await reconcile(id);
      const transfers = await provider.transfers(plan.paymentId);
      requireValue(transfers.every(transfer => transfer.status === 'failed' || transfer.amount_reversed === transfer.amount),
        'External or unreversed transfers require review before this payment can be refunded.');
      const operationId = hash(['refund', plan.paymentId]);
      const claim = await store.transaction(async transaction => {
        await access(transaction, true);
        const savedSource = await transaction.get(sourcePath(plan.paymentId));
        const plans = await Promise.all(savedSource.planIds.map(id => transaction.get(planPath(id))));
        requireValue(plans.every(value => value?.status === 'reversed'), 'Reverse and reconcile all allocations before refunding.');
        if (savedSource.refundOperationId) return false;
        transaction.update(sourcePath(plan.paymentId), { refundOperationId: operationId, refundStatus: 'started', updatedAtMs: now() });
        return true;
      });
      const payment = await gatewayPayment(plan, true);
      let refunds = await provider.refunds(plan.paymentId);
      if (claim) {
        requireValue((payment.amount_refunded ?? 0) === 0 && refunds.length === 0,
          'An external refund already exists. Reconcile it instead of issuing another.');
        await provider.refund(plan.paymentId, plan.sourceAmountPaise, operationId);
        refunds = await provider.refunds(plan.paymentId);
      }
      const matches = refunds.filter(refund => refund.notes?.tk_route_operation === operationId);
      requireValue(matches.length <= 1, 'Duplicate refunds require team reconciliation.');
      const refund = matches[0];
      if (refund) requireValue(refund.payment_id === plan.paymentId && refund.amount === plan.sourceAmountPaise &&
        refund.currency === 'INR' && identifier(refund.id, 'rfnd'), 'The gateway refund does not match the cancelled Test payment.');
      const status = refund?.status === 'processed' ? 'refunded' : refund?.status === 'failed' ? 'failed' : 'unknown';
      const refreshed = await gatewayPayment(plan, true);
      requireValue(status !== 'refunded' || refreshed.amount_refunded === plan.sourceAmountPaise,
        'The refund amount is not confirmed by the source payment.');
      return store.transaction(async transaction => {
        await access(transaction);
        const saved = await transaction.get(planPath(planId));
        const record = await transaction.get(`payments/${plan.paymentId}`);
        const intent = record?.intentId ? await transaction.get(`rentPaymentIntents/${record.intentId}`) : null;
        const intentAccount = intent?.accountId ? await transaction.get(`rentPaymentAccounts/${intent.accountId}`) : null;
        transaction.update(sourcePath(plan.paymentId), { refundStatus: status, refundId: refund?.id ?? null, updatedAtMs: now() });
        transaction.update(planPath(planId), { refundStatus: status, version: saved.version + 1, updatedAtMs: now() });
        if (status === 'refunded') {
          transaction.update(`payments/${plan.paymentId}`, { status: 'refunded', refundedPaise: plan.sourceAmountPaise, updatedAtMs: now() });
          if (intent) transaction.update(`rentPaymentIntents/${record.intentId}`, { status: 'refunded', updatedAtMs: now() });
          if (intentAccount) transaction.update(`rentPaymentAccounts/${intent.accountId}`, { reconciliationRequired: true, updatedAtMs: now() });
        }
        return summary({ ...saved, refundStatus: status });
      });
    },
    async webhook(rawBody, signature, secret, eventId) {
      requireValue(validPaymentSignature(rawBody, signature, secret), 'Unverified Route webhook.', 'permission-denied');
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); } catch (_) { throw new PaymentError('invalid-argument', 'Invalid Route webhook.'); }
      if (!['transfer.processed', 'transfer.failed', 'transfer.reversed', 'settlement.processed'].includes(payload.event)) return { ignored: true };
      const eventPath = `routeTestWebhookEvents/${hash([eventId ?? hash(rawBody.toString('utf8'))])}`;
      const fingerprint = hash(rawBody.toString('utf8'));
      const previous = await store.transaction(async transaction => {
        const value = await transaction.get(eventPath);
        requireValue(!value || value.fingerprint === fingerprint, 'Webhook event ID was reused with different content.', 'permission-denied');
        return value;
      });
      if (previous?.complete) return { duplicate: true };
      const transfer = payload.payload?.transfer?.entity;
      const transferIds = identifier(transfer?.id, 'trf') ? [transfer.id] : [];
      const settlementId = payload.payload?.settlement?.entity?.id;
      if (payload.event === 'settlement.processed' && identifier(settlementId, 'setl')) {
        const transfers = await provider.settlementTransfers(settlementId);
        transferIds.push(...transfers.filter(value => value.recipient_settlement_id === settlementId && identifier(value.id, 'trf')).map(value => value.id));
      }
      const ids = await store.transaction(async transaction => {
        const indexes = await Promise.all([...new Set(transferIds)].map(id => transaction.get(`routeTestTransferIndex/${id}`)));
        return [...new Set(indexes.filter(Boolean).map(value => value.planId))];
      });
      const notedPlan = transfer?.notes?.tk_route_operation?.match(/^([a-f0-9]{64})-\d+$/)?.[1];
      if (notedPlan && !ids.includes(notedPlan)) ids.push(notedPlan);
      if (!ids.length) return { ignored: true };
      for (const id of ids) await reconcile(id, true);
      await store.transaction(async transaction => transaction.set(eventPath, { fingerprint, complete: true, planIds: ids, completedAtMs: now() }));
      return { processed: true };
    },
  };
}
