const allowedEmails = new Set([
  'ajaybhatnagar1712@gmail.com',
  'ajay@trustkeyper.com',
  'info@trustkeyper.com',
  'amanmaheshwari900@gmail.com',
]);

export class AdminGoogleAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const emailAddress = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const denied = () => new AdminGoogleAccessError('permission-denied', 'Use an approved Google account for TrustKeyper admin access.');

export async function authorizeAdminGoogleAccess({ auth, googleIdToken, verifyGoogle, readUser, store, now = Date.now }) {
  if (!auth?.uid) throw new AdminGoogleAccessError('unauthenticated', 'Sign in with Google first.');
  const token = auth.token;
  const email = emailAddress(token?.email);
  const signedInAt = token?.auth_time * 1000;
  const timestamp = now();
  const googleIds = token?.firebase?.identities?.['google.com'];
  if (!allowedEmails.has(email) || token?.email_verified !== true || token.firebase?.sign_in_provider !== 'google.com' ||
    !Array.isArray(googleIds) || googleIds.length !== 1 || typeof googleIds[0] !== 'string' || !googleIds[0] ||
    !Number.isInteger(token.auth_time) || timestamp - signedInAt > 300000 || signedInAt > timestamp + 30000) throw denied();
  if (typeof googleIdToken !== 'string' || googleIdToken.length > 6000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(googleIdToken)) throw denied();

  let google;
  try { google = await verifyGoogle(googleIdToken); }
  catch { throw denied(); }
  if (google?.sub !== googleIds[0] || emailAddress(google?.email) !== email || google?.email_verified !== true ||
    (email.endsWith('@trustkeyper.com') && google.hd !== 'trustkeyper.com')) throw denied();

  const user = await readUser(auth.uid);
  if (user?.uid !== auth.uid || user.disabled || user.emailVerified !== true || emailAddress(user.email) !== email ||
    !user.providerData?.some(provider => provider.providerId === 'google.com' && provider.uid === google.sub && emailAddress(provider.email) === email)) throw denied();

  const profilePath = `users/${auth.uid}`;
  const bindingPath = `websiteAdminGoogleBindings/${email}`;
  await store.transaction(async transaction => {
    const [profile, binding] = await Promise.all([transaction.get(profilePath), transaction.get(bindingPath)]);
    if (profile?.paused === true || (profile?.email && emailAddress(profile.email) !== email)) throw denied();
    const roles = profile?.roles ?? [];
    if (!Array.isArray(roles) || roles.some(role => typeof role !== 'string')) throw denied();
    if (binding) {
      if (binding.uid !== auth.uid || binding.googleSubject !== google.sub || !roles.includes('admin')) throw denied();
      return;
    }
    if (!roles.includes('admin')) transaction.merge(profilePath, { email, roles: [...roles, 'admin'] });
    transaction.create(bindingPath, { uid: auth.uid, googleSubject: google.sub, grantedAtMs: timestamp });
  });
  return { authorized: true };
}
