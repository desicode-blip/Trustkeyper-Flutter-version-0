const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'website/site/dist');
const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.website.json')));
const read = name => fs.readFileSync(path.join(dist, name), 'utf8');
const placeholderSlugs = ['for-property-agents', 'for-builders'];
const pages = ['index.html', 'contact-us/index.html', 'about-us/index.html', 'faqs/index.html', 'privacy-policy/index.html', 'terms-and-conditions/index.html', 'delete-account/index.html'];

test('website deployment is isolated from the customer app and retired services', () => {
  assert.equal(config.hosting.site, 'trustkeyper-website');
  assert.equal(config.hosting.public, 'website/site/dist');
  assert.equal(config.functions, undefined);
  const app = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json')));
  assert.equal(app.hosting.public, 'apps/flutter_app/build/web');
  assert.ok(config.hosting.rewrites.some(item => item.source === '/api/**' && item.function.functionId === 'websiteEnquiry'));
  assert.ok(config.hosting.rewrites.some(item => item.destination === '/admin/index.html'));
  assert.ok(config.hosting.redirects.some(item => item.destination === '/for-property-agents'));
});

test('active pages retain Login and all pages resolve local assets', () => {
  for (const name of [...pages, ...placeholderSlugs.map(slug => `${slug}/index.html`)]) {
    const html = read(name);
    if (pages.includes(name)) {
      assert.ok(html.includes('https://trustkeyper.web.app/#/login'), name);
      assert.ok(html.includes('/admin/#/admin'), name);
    }
    assert.doesNotMatch(html, /\{\{[^}]+\}\}|https?:\/\/(?:localhost|127\.0\.0\.1)|supabase|vercel\.app/i, name);
    for (const match of html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)) {
      const relative = decodeURIComponent(match[1]);
      if (relative.startsWith('/api/') || relative === '/admin/') continue;
      const file = path.join(dist, relative);
      assert.ok(fs.existsSync(file) || fs.existsSync(path.join(file, 'index.html')), `${name}: ${relative}`);
    }
  }
  assert.ok(read('index.html').includes('Your home in Hyderabad'));
});

test('broker and builder pages display only Coming soon', () => {
  for (const slug of placeholderSlugs) {
    const html = read(`${slug}/index.html`);
    assert.ok(html.includes(`<link rel="canonical" href="https://trustkeyper.com/${slug}">`));
    assert.doesNotMatch(html, /<script\b/);
    assert.match(html, /<body[^>]*>\s*<main[^>]*>\s*<h1[^>]*>Coming soon<\/h1>\s*<\/main>\s*<\/body>/);
  }
  assert.ok(read('for-brokers/index.html').includes('content="0; url=/for-property-agents"'));
});

test('the enquiry implementation never simulates OTP on deployed hosts', () => {
  const script = read('website.js');
  const flag = script.match(/const OTP_PREVIEW = (.*);/)[1];
  for (const hostname of ['trustkeyper.com', 'www.trustkeyper.com', 'trustkeyper-website.web.app', 'trustkeyper-website.firebaseapp.com', 'unrecognised.example']) {
    assert.equal(vm.runInNewContext(flag, { location: { hostname } }), false, hostname);
  }
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) assert.equal(vm.runInNewContext(flag, { location: { hostname } }), true);
  assert.match(script, /OTP_PREVIEW\) throw new Error\('This is a local preview/);
  assert.match(script, /challengeId/);
  assert.match(script, /if \(otpBusy \|\| code\(\).length !== 6/);
});

test('all generated scripts parse and expanded sections reference real panels', () => {
  for (const name of ['website.js', 'agent.js']) assert.doesNotThrow(() => new vm.Script(read(name)));
  for (const name of ['index.html', 'for-property-agents/index.html', 'for-builders/index.html', 'contact-us/index.html']) {
    const html = read(name);
    for (const match of html.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(html.includes(`id="${match[1]}"`), `${name}: ${match[1]}`);
  }
  assert.doesNotMatch(read('for-brokers/index.html'), /<script>/);
});

test('the original phone and email popup and all four enquiry branches are rendered', () => {
  for (const name of ['index.html', 'contact-us/index.html']) {
    const html = read(name);
    assert.match(html, /data-open-otp="phone"/);
    assert.match(html, /data-otp-phone-wrap><span>\+91<\/span><input type="tel"/);
    assert.match(html, /data-otp-step="code" hidden/);
    assert.match(html, /data-otp-alternatives hidden/);
    assert.doesNotMatch(html, /data-otp-fallback/);
    assert.match(html, /class="tkf-after" data-after hidden/);
    for (const role of ['property_owner', 'tenant', 'broker', 'builder']) assert.match(html, new RegExp(`data-for="${role}" hidden`));
  }
  assert.match(read('website.js'), /openOtp\(opener.dataset.openOtp, opener\)/);
  assert.doesNotMatch(read('website.js'), /data-otp-fallback/);
});

test('every role shows named service checkboxes plus a separate select-all control', () => {
  for (const name of ['index.html', 'contact-us/index.html']) {
    const html = read(name);
    const groups = [...html.matchAll(/<div class="tkf-chips" data-most>([\s\S]*?)<\/div>/g)];
    assert.equal(groups.length, 4);
    for (const [index, group] of groups.entries()) {
      const options = [...group[1].matchAll(/<input type="checkbox" name="([^"]+)" value="([^"]+)"><span>([^<]+)<\/span>/g)];
      assert.equal(options.length, [7, 5, 4, 5][index]);
      for (const [, optionName, value, label] of options) {
        assert.equal(optionName, ['ownerMost', 'tenantMost', 'agentMost', 'builderMost'][index]);
        assert.equal(value, label);
      }
      assert.match(group[1], /<input type="checkbox" data-select-all><span>All of the above<\/span>/);
      assert.doesNotMatch(group[1], /type="radio"/);
    }
  }
});

test('phone verification uses an isolated, temporary Auth session on enquiry pages only', () => {
  const phoneScript = read('website-phone-auth.js');
  assert.match(phoneScript, /projectId = 'trustkeyper-website-otp'/);
  assert.match(phoneScript, /initializeAuth\(app, \{ persistence: authSdk.inMemoryPersistence \}\)/);
  assert.match(phoneScript, /RecaptchaVerifier/);
  assert.match(phoneScript, /finally \{ await authSdk.signOut\(auth\); \}/);
  assert.doesNotMatch(phoneScript, /appVerificationDisabledForTesting|123456/);
  const policies = config.hosting.headers.filter(item => item.headers.some(header => header.value.includes('identitytoolkit.googleapis.com')));
  assert.deepEqual(policies.map(item => item.source), ['/', '/contact-us{,/**}']);
});

test('notification recipient and admin access are server-controlled', () => {
  const source = fs.readFileSync(path.join(root, 'functions/website-enquiries.js'), 'utf8');
  assert.ok(source.includes("to: ['amanmaheshwari900@gmail.com']"));
  assert.ok(source.includes('https://trustkeyper.com/admin/#/admin/enquiries'));
  const service = fs.readFileSync(path.join(root, 'functions/website-enquiry-admin.js'), 'utf8');
  assert.match(service, /Array\.isArray\(profile\?\.roles\)/);
  assert.match(service, /profile\.paused === true/);
  assert.ok(!JSON.stringify(config).includes('firestore.rules'));
});
