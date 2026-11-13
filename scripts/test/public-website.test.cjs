const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const website = path.join(root, 'apps/flutter_app/website');
const pageNames = ['index', 'for-brokers', 'contact-us', 'terms-and-conditions', 'about-us', 'faqs', 'privacy-policy', 'delete-account'];
const script = fs.readFileSync(path.join(website, 'website.js'), 'utf8');

test('public website is separate from the existing Flutter Hosting release', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json')));
  const siteConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.website.json')));
  assert.equal(appConfig.hosting.public, 'apps/flutter_app/build/web');
  assert.equal(siteConfig.hosting.public, 'apps/flutter_app/website');
  assert.equal(siteConfig.hosting.site, 'trustkeyper-website');
  assert.equal(siteConfig.hosting.rewrites.length, 1);
  assert.equal(siteConfig.hosting.rewrites[0].function.functionId, 'submitWebsiteContact');
  assert.equal(siteConfig.functions, undefined);
});

test('all recovered public pages have local assets and only the new website script', () => {
  for (const name of pageNames) {
    const html = fs.readFileSync(path.join(website, `${name}.html`), 'utf8');
    assert.ok(html.includes('https://trustkeyper.web.app/#/login'), name);
    assert.doesNotMatch(html, /index-CwMUakfZ\.js|supabase|\/login\/existing|data-codex|localhost|127\.0\.0\.1/i, name);
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, name);
    assert.match(html, /<script src="\/website.js" defer="">/);
    for (const match of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
      const relative = decodeURIComponent(match[1]);
      if (relative === '/' || relative === '/api/contact') continue;
      const file = path.join(website, relative.slice(1));
      assert.ok(fs.existsSync(file) || fs.existsSync(`${file}.html`), `${name}: ${relative}`);
    }
  }
});

test('FAQ panels, mobile menu and contact controls are available without the old runtime', () => {
  for (const name of ['index', 'for-brokers']) {
    const html = fs.readFileSync(path.join(website, `${name}.html`), 'utf8');
    const toggles = [...html.matchAll(/<button\b[^>]*data-faq-toggle[^>]*>/g)];
    assert.equal(toggles.length, name === 'index' ? 8 : 4);
    for (const toggle of toggles) {
      const panel = toggle[0].match(/aria-controls="([^"]+)"/)[1];
      assert.ok(html.includes(`id="${panel}"`), panel);
    }
    assert.match(html, /id="mobile-menu" hidden/);
    assert.match(html, /<form\b[^>]*data-contact-form/);
    assert.equal((html.match(/data-contact-role=/g) ?? []).length, 3);
  }
});

test('browser validation accepts required fields and reports specific errors', () => {
  const context = vm.createContext({ location: { hash: '' }, document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener() {} } });
  vm.runInContext(script, context);
  const values = { firstName: 'Local', lastName: 'Tester', phone: '9000000001', email: '', role: 'tenant', serviceTiming: 'exploring', message: 'Local test' };
  assert.equal(Object.keys(context.validateWebsiteContact(values)).length, 0);
  assert.deepEqual(Object.keys(context.validateWebsiteContact({ ...values, firstName: '', phone: '123', email: 'bad', role: '' })).sort(), ['email', 'firstName', 'phone', 'role']);
});

test('legacy custom-domain Flutter hash links preserve their destination', () => {
  let destination;
  const hash = '#/documents/request?token=local-test-placeholder';
  vm.runInNewContext(script, { location: { hash, replace: value => { destination = value; } }, document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener() {} } });
  assert.equal(destination, `https://trustkeyper.web.app/${hash}`);
});
