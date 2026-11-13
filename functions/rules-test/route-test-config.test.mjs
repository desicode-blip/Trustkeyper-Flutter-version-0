import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assertFails, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

let environment;
const configPath = 'serverConfig/razorpayRouteTest';
const privateCollections = ['routeTestPayoutPlans', 'routeTestPayoutSources', 'routeTestRepairClaims',
  'routeTestBrokerageFunding', 'routeTestBrokerageClaims', 'routeTestTransferIndex',
  'routeTestReversalOperations', 'routeTestAgreementGates', 'routeTestWebhookEvents'];
before(async () => {
  environment = await initializeTestEnvironment({ projectId: 'demo-trustkeyper-rules',
    firestore: { host: '127.0.0.1', port: 8080,
      rules: await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
  await environment.withSecurityRulesDisabled(async context => {
    for (const role of ['broker', 'owner', 'tenant', 'admin']) {
      await setDoc(doc(context.firestore(), `users/route-fixture-${role}`), { roles: [role], approvalStatus: 'approved' });
    }
    await setDoc(doc(context.firestore(), configPath), { schemaVersion: 1, mode: 'test',
      transfersEnabled: false, liveTransfersEnabled: false, status: 'pending_product_verification',
      beneficiaries: { broker: { uid: 'route-fixture-broker', accountId: 'acc_FixtureBroker' },
        owner: { uid: 'route-fixture-owner', accountId: 'acc_FixtureOwner' } } });
    for (const name of privateCollections) await setDoc(doc(context.firestore(), `${name}/fixture`), { mode: 'test', status: 'held' });
  });
});
after(async () => environment?.cleanup());

for (const role of ['broker', 'owner', 'tenant', 'admin', 'anonymous']) {
  test(`${role} cannot read or mutate the server-only Test Route mapping`, async () => {
    const context = role === 'anonymous' ? environment.unauthenticatedContext()
      : environment.authenticatedContext(`route-fixture-${role}`);
    const database = context.firestore();
    const reference = doc(database, configPath);
    await assertFails(getDoc(reference));
    await assertFails(getDocs(collection(database, 'serverConfig')));
    await assertFails(setDoc(reference, { mode: 'live', transfersEnabled: true }));
    await assertFails(updateDoc(reference, { 'beneficiaries.owner.accountId': 'acc_Attacker' }));
    await assertFails(updateDoc(reference, { transfersEnabled: true }));
    await assertFails(deleteDoc(reference));
    await assertFails(setDoc(doc(database, 'serverConfig/forgedRoute'), { transfersEnabled: true }));
    for (const name of privateCollections) {
      const record = doc(database, `${name}/fixture`);
      await assertFails(getDoc(record));
      await assertFails(getDocs(collection(database, name)));
      await assertFails(setDoc(record, { status: 'settled' }));
      await assertFails(updateDoc(record, { status: 'settled' }));
      await assertFails(deleteDoc(record));
    }
  });
}
