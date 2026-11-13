import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRouteTestPayoutService } from '../route-test-payouts.js';
import { approvalDigest } from '../agreement-approvals.js';
import { reviewSnapshot } from '../agreement-review.js';

function fixture() {
  let time = Date.parse('2026-10-10T00:00:00Z');
  let serial = Promise.resolve();
  let sequence = 0;
  const agreement = { schemaVersion: 2, revision: 1, status: 'signed_copy_received', brokerUid: 'broker',
    participantUids: ['broker', 'owner', 'owner2', 'tenant'], propertyAddress: 'Synthetic test property',
    owners: [{ id: 'owner', name: 'Owner', phone: '+919000000001', email: '', rentSharePaise: 0, depositSharePaise: 0 },
      { id: 'owner2', name: 'Owner Two', phone: '+919000000002', email: '', rentSharePaise: 0, depositSharePaise: 0 }],
    tenants: [{ id: 'tenant', name: 'Tenant', phone: '+919000000003', email: '', rentSharePaise: 100000, depositSharePaise: 200000 }],
    monthlyRentPaise: 100000, monthlyMaintenancePaise: 1000, securityDepositPaise: 200000,
    ownerBrokeragePaise: 25000, tenantBrokeragePaise: 50000, startDateISO: '2026-10-01T00:00:00.000',
    endDateISO: '2027-08-31T00:00:00.000', rentDueDay: 5, lockInMonths: 6, noticeMonths: 1 };
  agreement.agreementCopy = { mode: 'externally_signed', revision: 1, digest: approvalDigest(reviewSnapshot(agreement)),
    file: { sha256: 'a'.repeat(64) }, attestation: { approvedOriginal: true, allPartiesSigned: true, matchesReviewedTerms: true },
    people: [...agreement.owners.map(person => ({ ...person, uid: person.id, role: 'owner' })),
      { id: 'tenant', uid: 'tenant', role: 'tenant', phone: '+919000000003' }] };
  const config = { mode: 'test', transfersEnabled: true, liveTransfersEnabled: false,
    beneficiaries: Object.fromEntries(['owner', 'owner2', 'broker'].map(uid => [uid,
      { uid, role: uid === 'broker' ? 'broker' : 'owner', mode: 'test', accountId: `acc_${uid}`, accountLookupVerified: true }])) };
  const payment = { mode: 'test', status: 'paid', agreementId: 'fixture', revision: 1, orderId: 'order_one',
    amountPaise: 301000, depositPaise: 200000, intentId: 'intent',
    lines: [{ month: '2026-10', rentPaise: 100000, maintenancePaise: 1000, totalPaise: 101000 }] };
  let data = new Map([['agreements/fixture', agreement], ['payments/pay_one', payment],
    ['serverConfig/razorpayRouteTest', config], ['rentPaymentIntents/intent', { accountId: 'account', status: 'paid' }],
    ['rentPaymentAccounts/account', { paidMonths: ['2026-10'], depositPaid: true }],
    ...['owner', 'owner2', 'tenant', 'broker', 'admin'].map(uid => [`users/${uid}`, {
      roles: [uid === 'owner2' ? 'owner' : uid], approvalStatus: 'approved', displayName: uid }])]);
  const store = { transaction(handler) {
    const operation = serial.then(async () => {
      const next = structuredClone(data);
      let written = false;
      const result = await handler({
        get: async path => { assert.equal(written, false, 'all reads precede writes'); return structuredClone(next.get(path)); },
        set: (path, value) => { written = true; next.set(path, structuredClone(value)); },
        update: (path, value) => {
          assert.ok(next.has(path), `update requires a saved document: ${path}`);
          written = true; next.set(path, { ...next.get(path), ...structuredClone(value) });
        },
      });
      data = next;
      return result;
    });
    serial = operation.catch(() => {});
    return operation;
  } };
  const gatewayPayments = new Map([['pay_one', { id: 'pay_one', entity: 'payment', order_id: 'order_one', amount: 301000,
    amount_refunded: 0, currency: 'INR', status: 'captured', captured: true }]]);
  const transfers = [];
  const refunds = [];
  const calls = { create: 0, reverse: 0, refund: 0, hold: 0, reads: 0 };
  const provider = { mode: 'test',
    payment: async id => { calls.reads++; return structuredClone(gatewayPayments.get(id)); },
    linkedAccount: async id => ({ id, type: 'route', status: 'created' }),
    transfers: async id => structuredClone(transfers.filter(transfer => transfer.source === id)),
    transfer: async id => structuredClone(transfers.find(transfer => transfer.id === id)),
    createHeldTransfers: async (id, parts) => {
      calls.create++;
      for (const part of parts.slice(0, provider.partial ? 1 : parts.length)) transfers.push({ id: `trf_${++sequence}`,
        entity: 'transfer', source: id, recipient: part.accountId, amount: part.amountPaise, currency: 'INR',
        on_hold: true, status: 'processed', amount_reversed: 0, notes: { tk_route_operation: part.operationId } });
      if (provider.createError) throw provider.createError;
      return structuredClone(transfers);
    },
    hold: async (id, held) => { calls.hold++; transfers.find(transfer => transfer.id === id).on_hold = held; },
    settlement: async id => ({ id, entity: 'settlement', status: provider.settled ? 'processed' : 'created' }),
    settlementTransfers: async id => structuredClone(transfers.filter(transfer => transfer.recipient_settlement_id === id)),
    reverse: async (id, amountPaise) => {
      calls.reverse++;
      transfers.find(transfer => transfer.id === id).amount_reversed += amountPaise;
      if (provider.reverseError) throw provider.reverseError;
    },
    refunds: async id => structuredClone(refunds.filter(refund => refund.payment_id === id)),
    refund: async (id, amountPaise, operationId) => {
      calls.refund++;
      refunds.push({ id: `rfnd_${++sequence}`, payment_id: id, amount: amountPaise, currency: 'INR',
        status: 'processed', notes: { tk_route_operation: operationId } });
      Object.assign(gatewayPayments.get(id), { amount_refunded: amountPaise, status: 'refunded' });
      if (provider.refundError) throw provider.refundError;
    },
  };
  const service = (uid = 'admin') => createRouteTestPayoutService({ store, provider, auth: uid ? { uid } : undefined,
    now: () => time, nonce: () => `lease${++sequence}` });
  const flow = service();
  const input = { paymentId: 'pay_one', confirmContractTerms: true, month: '2026-10', feeBasisPoints: 1000,
    ownerShares: [{ uid: 'owner', basisPoints: 10000 }] };
  const gate = () => ({ mode: 'test', revision: 1, digest: agreement.agreementCopy.digest,
    allTenantsInitialPaymentsVerified: true, physicalMoveInConfirmed: true, moveInAtMs: time - 3 * 86400000 });
  function brokerage(id = 'pay_brokerage', amountPaise = 75000) {
    data.set(`payments/${id}`, { ...payment, purpose: 'brokerage_collection', orderId: `order_${id.replace('pay_', '')}`,
      amountPaise, depositPaise: 0, lines: [] });
    gatewayPayments.set(id, { ...gatewayPayments.get('pay_one'), id, order_id: `order_${id.replace('pay_', '')}`, amount: amountPaise });
    data.set(`routeTestBrokerageFunding/${id}`, { paymentId: id, purpose: 'separate_brokerage_collection',
      agreementId: 'fixture', revision: 1, digest: agreement.agreementCopy.digest, amountPaise, approved: true });
    return { paymentId: id, kind: 'brokerage', confirmContractTerms: true };
  }
  return { flow, service, input, provider, calls, transfers, gatewayPayments, refunds, gate, brokerage,
    get: path => data.get(path), set: (path, value) => data.set(path, value),
    clock: value => { time = value; }, all: () => [...data] };
}

test('only enabled admin with Test provider/config and a matching actual signed copy can prepare', async () => {
  for (const uid of [null, 'broker', 'owner', 'tenant']) {
    const value = fixture();
    await assert.rejects(value.service(uid).prepare(value.input));
    assert.equal(value.calls.create, 0);
  }
  for (const change of ['paused', 'liveProvider', 'liveConfig', 'demo', 'revision', 'digest', 'attestation']) {
    const value = fixture();
    const agreement = value.get('agreements/fixture');
    if (change === 'paused') value.set('users/admin', { roles: ['admin'], paused: true });
    if (change === 'liveProvider') value.provider.mode = 'live';
    if (change === 'liveConfig') value.get('serverConfig/razorpayRouteTest').liveTransfersEnabled = true;
    if (change === 'demo') agreement.agreementCopy.mode = 'demo';
    if (change === 'revision') agreement.revision++;
    if (change === 'digest') agreement.monthlyRentPaise++;
    if (change === 'attestation') agreement.agreementCopy.attestation.allPartiesSigned = false;
    await assert.rejects(value.flow.prepare(value.input));
  }
});

test('explicit fee and owner shares required; rent only, no deposit, maintenance or brokerage allocation', async () => {
  for (const patch of [{ feeBasisPoints: undefined }, { feeBasisPoints: 499 }, { feeBasisPoints: 2001 },
    { ownerShares: [] }, { ownerShares: [{ uid: 'owner', basisPoints: 9999 }] },
    { ownerShares: [{ uid: 'tenant', basisPoints: 10000 }] }, { confirmContractTerms: false }]) {
    const value = fixture();
    await assert.rejects(value.flow.prepare({ ...value.input, ...patch }));
  }
  const value = fixture();
  const result = await value.flow.prepare(value.input);
  assert.equal(result.amountPaise, 90000);
  assert.equal(result.feePaise, 10000);
  assert.equal(result.depositTransferredPaise, 0);
  assert.equal(result.scheduledAtMs, Date.parse('2026-10-07T00:00:00+05:30'));
  assert.equal(value.get('routeTestPayoutSources/pay_one').reservedPaise, 100000);
  assert.deepEqual(await value.flow.prepare(value.input), result);
  await assert.rejects(value.flow.prepare({ ...value.input, feeBasisPoints: 1500 }), { code: 'aborted' });
  await assert.rejects(value.flow.prepare({ ...value.input, kind: 'brokerage' }));
});

test('approved repair reservations are single-use, exact month and immutable before sending', async () => {
  const value = fixture();
  value.set('repairCharges/repair', { agreementId: 'fixture', source: 'verified_repair_completion',
    status: 'pending_reconciliation', amountPaise: 1234, payoutDateISO: '2026-10-07', completionUploadId: 'verifiedUpload' });
  const input = { ...value.input, repairIds: ['repair'] };
  const plan = await value.flow.prepare(input);
  assert.equal(plan.amountPaise, 88766);
  value.get('repairCharges/repair').amountPaise++;
  await assert.rejects(value.flow.send({ planId: plan.planId }));
  assert.equal(value.calls.create, 0);
});

test('co-owner paise allocation is explicit and conserves the net amount', async () => {
  const value = fixture();
  const result = await value.flow.prepare({ ...value.input, feeBasisPoints: 777,
    ownerShares: [{ uid: 'owner', basisPoints: 3333 }, { uid: 'owner2', basisPoints: 6667 }] });
  assert.equal(result.feePaise, 7770);
  assert.equal(result.parts.reduce((total, part) => total + part.amountPaise, 0), 92230);
  assert.equal(result.parts[0].amountPaise, Math.floor(92230 * 3333 / 10000));
});

test('concurrent or repeated sends submit one held batch only', async () => {
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await Promise.all([value.flow.send({ planId: plan.planId }), value.flow.send({ planId: plan.planId })]);
  const result = await value.flow.send({ planId: plan.planId });
  assert.equal(result.status, 'held');
  assert.equal(value.calls.create, 1);
  assert.equal(value.calls.hold, 0);
  assert.equal(value.get(`payouts/${plan.planId}-0`).mode, 'test');
});

test('disabled config or changed beneficiaries cannot send even a previously prepared plan', async () => {
  for (const change of ['disabled', 'mapping', 'paused']) {
    const value = fixture();
    const plan = await value.flow.prepare(value.input);
    if (change === 'disabled') value.get('serverConfig/razorpayRouteTest').transfersEnabled = false;
    if (change === 'mapping') value.get('serverConfig/razorpayRouteTest').beneficiaries.owner.accountId = 'acc_changed';
    if (change === 'paused') value.get('users/owner').paused = true;
    await assert.rejects(value.flow.send({ planId: plan.planId }));
    assert.equal(value.calls.create, 0);
  }
});

test('timeout after accepted batch reconciles and never resubmits, including partial results', async () => {
  for (const partial of [false, true]) {
    const value = fixture();
    const plan = await value.flow.prepare({ ...value.input,
      ownerShares: [{ uid: 'owner', basisPoints: 5000 }, { uid: 'owner2', basisPoints: 5000 }] });
    value.provider.partial = partial;
    value.provider.createError = new Error('response lost');
    assert.equal((await value.flow.send({ planId: plan.planId })).status, 'unknown');
    await value.flow.send({ planId: plan.planId });
    const result = await value.flow.reconcile({ planId: plan.planId });
    assert.equal(result.status, partial ? 'partial' : 'held');
    assert.equal(value.calls.create, 1);
  }
});

test('missing, duplicate or mismatched provider transfers do not become successful payouts', async () => {
  for (const change of ['missing', 'duplicate', 'recipient', 'amount', 'source']) {
    const value = fixture();
    const plan = await value.flow.prepare(value.input);
    await value.flow.send({ planId: plan.planId });
    if (change === 'missing') value.transfers.length = 0;
    if (change === 'duplicate') value.transfers.push({ ...value.transfers[0], id: 'trf_duplicate' });
    if (change === 'recipient') value.transfers[0].recipient = 'acc_other';
    if (change === 'amount') value.transfers[0].amount++;
    if (change === 'source') value.transfers[0].source = 'pay_other';
    if (['missing', 'source'].includes(change)) assert.equal((await value.flow.reconcile({ planId: plan.planId })).status, 'unknown');
    else await assert.rejects(value.flow.reconcile({ planId: plan.planId }));
    assert.equal(value.calls.create, 1);
  }
});

test('holds require verified actual move-in, every initial payment, matching legal revision and due date', async () => {
  for (const change of ['absent', 'payment', 'movein', 'revision', 'digest', 'date']) {
    const value = fixture();
    const plan = await value.flow.prepare(value.input);
    await value.flow.send({ planId: plan.planId });
    const gate = value.gate();
    if (change === 'payment') gate.allTenantsInitialPaymentsVerified = false;
    if (change === 'movein') gate.physicalMoveInConfirmed = false;
    if (change === 'revision') gate.revision++;
    if (change === 'digest') gate.digest = 'changed';
    if (change === 'date') value.clock(Date.parse('2026-10-06T00:00:00Z'));
    if (change !== 'absent') value.set('routeTestAgreementGates/fixture', gate);
    await assert.rejects(value.flow.release({ planId: plan.planId }));
    assert.equal(value.calls.hold, 0);
  }
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await value.flow.send({ planId: plan.planId });
  value.set('routeTestAgreementGates/fixture', value.gate());
  assert.equal((await value.flow.release({ planId: plan.planId })).status, 'awaiting_settlement');
  value.transfers[0].recipient_settlement_id = 'setl_one';
  assert.equal((await value.flow.reconcile({ planId: plan.planId })).status, 'awaiting_settlement');
  value.provider.settled = true;
  assert.equal((await value.flow.reconcile({ planId: plan.planId })).status, 'settled');
});

test('separate brokerage is capped once across payments; repeated preparation is idempotent', async () => {
  const value = fixture();
  const input = value.brokerage();
  const plan = await value.flow.prepare(input);
  assert.equal(plan.amountPaise, 75000);
  assert.equal(plan.parts[0].role, 'broker');
  assert.deepEqual(await value.flow.prepare(input), plan);
  await assert.rejects(value.flow.prepare(value.brokerage('pay_second', 100)));
  await value.flow.send({ planId: plan.planId });
  const gate = value.gate();
  gate.moveInAtMs = Date.parse('2026-10-09T00:00:00Z');
  value.set('routeTestAgreementGates/fixture', gate);
  await assert.rejects(value.flow.release({ planId: plan.planId }));
  assert.equal(value.calls.hold, 0);
});

test('reversal lost response is recovered without a second reversal POST', async () => {
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await value.flow.send({ planId: plan.planId });
  value.provider.reverseError = new Error('response lost');
  await assert.rejects(value.flow.reverse({ planId: plan.planId }));
  assert.equal((await value.flow.reverse({ planId: plan.planId })).status, 'reversed');
  assert.equal(value.calls.reverse, 1);
});

test('full Test refund waits for every reversal; unknown outcome is reconciled without duplicate refund', async () => {
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await value.flow.send({ planId: plan.planId });
  await assert.rejects(value.flow.refund({ planId: plan.planId, confirmFullTestCancellation: true }));
  assert.equal(value.calls.refund, 0);
  await value.flow.reverse({ planId: plan.planId });
  value.provider.refundError = new Error('response lost');
  await assert.rejects(value.flow.refund({ planId: plan.planId, confirmFullTestCancellation: true }));
  const result = await value.flow.refund({ planId: plan.planId, confirmFullTestCancellation: true });
  assert.equal(result.refundStatus, 'refunded');
  assert.equal(value.calls.refund, 1);
  assert.equal(value.get('payments/pay_one').status, 'refunded');
  assert.equal(value.get('rentPaymentAccounts/account').reconciliationRequired, true);
  assert.deepEqual(value.get('rentPaymentAccounts/account').paidMonths, ['2026-10']);
  assert.equal(value.get('rentPaymentAccounts/account').depositPaid, true);
});

test('out-of-band refund blocks fresh checkout bookkeeping and foreign unreversed transfers block refunds', async () => {
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await value.flow.send({ planId: plan.planId });
  await value.flow.reverse({ planId: plan.planId });
  value.transfers.push({ id: 'trf_foreign', source: 'pay_one', amount: 100, amount_reversed: 0, status: 'processed' });
  await assert.rejects(value.flow.refund({ planId: plan.planId, confirmFullTestCancellation: true }));
  assert.equal(value.calls.refund, 0);
  value.gatewayPayments.get('pay_one').amount_refunded = 1;
  await value.flow.reconcile({ planId: plan.planId });
  assert.equal(value.get('payments/pay_one').status, 'reconciliation_required');
  assert.equal(value.get('rentPaymentAccounts/account').reconciliationRequired, true);
});

test('signed raw webhook reconciles actual provider facts; forged or duplicate events cannot move money', async () => {
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await value.flow.send({ planId: plan.planId });
  const body = Buffer.from(JSON.stringify({ event: 'transfer.processed', payload: { transfer: { entity: value.transfers[0] } } }));
  const secret = 'fixture-webhook-secret';
  const sign = bytes => createHmac('sha256', secret).update(bytes).digest('hex');
  await assert.rejects(value.flow.webhook(Buffer.concat([body, Buffer.from(' ')]), sign(body), secret, 'one'));
  assert.deepEqual(await value.service(null).webhook(body, sign(body), secret, 'one'), { processed: true });
  const reads = value.calls.reads;
  assert.deepEqual(await value.service(null).webhook(body, sign(body), secret, 'one'), { duplicate: true });
  assert.equal(value.calls.reads, reads);
  assert.equal(value.calls.create, 1);
  assert.equal(value.calls.hold, 0);
});

test('recipient settlement webhook finds saved transfer indexes even without operation notes in its payload', async () => {
  const value = fixture();
  const plan = await value.flow.prepare(value.input);
  await value.flow.send({ planId: plan.planId });
  value.transfers[0].on_hold = false;
  value.transfers[0].recipient_settlement_id = 'setl_one';
  value.provider.settled = true;
  const body = Buffer.from(JSON.stringify({ event: 'settlement.processed', payload: { settlement: {
    entity: { id: 'setl_one', entity: 'settlement', status: 'processed' } } } }));
  const secret = 'fixture-webhook-secret';
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  assert.deepEqual(await value.service(null).webhook(body, signature, secret, 'settlement-one'), { processed: true });
  assert.equal((await value.flow.read({ planId: plan.planId })).status, 'settled');
  assert.deepEqual(await value.service(null).webhook(body, signature, secret, 'settlement-one'), { duplicate: true });
});
