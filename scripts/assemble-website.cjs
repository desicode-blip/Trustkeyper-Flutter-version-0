const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'output/website-release/admin');
const destination = path.join(root, 'website/site/dist/admin');
if (!fs.existsSync(path.join(source, 'main.dart.js')) || !fs.existsSync(path.join(root, 'website/site/dist/index.html'))) {
  throw new Error('Build both the static website and admin_main.dart before assembling the release.');
}
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
const indexPath = path.join(destination, 'index.html');
const index = fs.readFileSync(indexPath, 'utf8');
if (!index.includes('<base href="/admin/">')) throw new Error('The admin bundle must use /admin/ as its base href.');
fs.writeFileSync(indexPath, index.replace('<title>TrustKeyper</title>', '<title>TrustKeyper Admin</title>'));
const phoneConfig = path.join(root, 'output/website-release/website-otp-config.json');
if (fs.existsSync(phoneConfig)) {
  const { projectId, authDomain, apiKey, appId } = JSON.parse(fs.readFileSync(phoneConfig, 'utf8'));
  if (projectId !== 'trustkeyper-website-otp' || authDomain !== `${projectId}.firebaseapp.com` ||
    appId !== '1:418312692327:web:3dbc42873074cf44572ac2' || typeof apiKey !== 'string' || !apiKey) {
    throw new Error('Website SMS must use the isolated TrustKeyper Website OTP web app.');
  }
  fs.writeFileSync(path.join(destination, '..', 'website-otp-config.json'), JSON.stringify({ projectId, authDomain, apiKey, appId }));
}
console.log('Assembled static website and isolated Flutter admin portal in website/site/dist.');
