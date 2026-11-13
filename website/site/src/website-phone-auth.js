const projectId = 'trustkeyper-website-otp';
const sdkRoot = 'https://www.gstatic.com/firebasejs/12.4.0/';
let authClient;

async function loadClient() {
  const response = await fetch('/website-otp-config.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('SMS verification is not available yet.');
  const config = await response.json();
  if (config.projectId !== projectId || config.authDomain !== `${projectId}.firebaseapp.com` || !config.apiKey || !config.appId) {
    throw new Error('SMS verification is not available yet.');
  }
  const [appSdk, authSdk] = await Promise.all([import(`${sdkRoot}firebase-app.js`), import(`${sdkRoot}firebase-auth.js`)]);
  const app = appSdk.initializeApp(config, projectId);
  return { authSdk, auth: authSdk.initializeAuth(app, { persistence: authSdk.inMemoryPersistence }) };
}

function smsError(error, verifying) {
  switch (error?.code) {
    case 'auth/invalid-verification-code': return 'That code is not right. Please try again.';
    case 'auth/code-expired':
    case 'auth/session-expired': return 'This code expired. Request a new code.';
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded': return 'Too many SMS attempts. Please wait a few minutes or verify by email.';
    case 'auth/captcha-check-failed': return 'The security check did not complete. Please try again.';
    default: return verifying ? 'We could not verify that code. Please try again.' : 'The SMS could not be sent. Please try again or verify by email.';
  }
}

export async function sendWebsitePhoneCode(phone, container, signal) {
  authClient ??= loadClient().catch(() => {
    authClient = undefined;
    throw new Error('SMS verification is not available right now.');
  });
  const { auth, authSdk } = await authClient;
  signal.throwIfAborted();
  const mount = document.createElement('div');
  container.appendChild(mount);
  let verifier;
  const clear = () => {
    if (verifier) verifier.clear();
    verifier = undefined;
    mount.remove();
  };
  signal.addEventListener('abort', clear, { once: true });
  let confirmation;
  try {
    verifier = new authSdk.RecaptchaVerifier(auth, mount, { size: 'invisible' });
    confirmation = await authSdk.signInWithPhoneNumber(auth, phone, verifier);
    signal.throwIfAborted();
  } catch (error) {
    throw new Error(smsError(error, false));
  } finally {
    signal.removeEventListener('abort', clear);
    clear();
  }
  return async code => {
    try {
      const credential = await confirmation.confirm(code);
      try { return await credential.user.getIdToken(); }
      finally { await authSdk.signOut(auth); }
    } catch (error) { throw new Error(smsError(error, true)); }
  };
}
