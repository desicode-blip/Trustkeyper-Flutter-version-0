# Website phone enquiries

The public homepage and Contact Us use the same enquiry form. Phone number
opens the existing `+91` popup, then six-digit verification, then the original
role-specific questions. Phone enquiries appear in the existing admin inbox and
send the existing notification to Aman. This is not an app sign-in.

## SMS project

Use the separate Firebase project `trustkeyper-website-otp` and web app
`1:418312692327:web:3dbc42873074cf44572ac2`. Phone Authentication is enabled,
with billing linked to the existing TrustKeyper billing account, SMS restricted
to India and no fictional numbers configured. Do not enable other providers or
use the app's project for enquiry verification.

Save the [web app config](https://console.firebase.google.com/project/trustkeyper-website-otp/settings/general)
as JSON in ignored `output/website-release/website-otp-config.json` before
assembling a release. The assembler validates the project and app IDs before
copying the public client configuration. Do not commit or log it, and do not
put credentials or service-account keys in it.

Firebase delivers the code with reCAPTCHA abuse protection. It retains an Auth
record only in the separate project. The browser signs out immediately after
obtaining proof; the existing `websiteEnquiry` function checks the signed token
for the expected project, provider, phone number and a recent sign-in. One
successful phone verification can authorize only one enquiry. No shared Auth
session, app account, or cross-project service-account permission is needed.

## Validate and release

- Run `node --test functions/test/website-enquiries.test.js` for token exchange,
  replay protection, inbox and notification tests. Build the website and run
  the website tooling tests. The loopback preview sends no SMS or enquiries.
- After concrete production approval, deploy only `websiteEnquiry` and the
  `trustkeyper-website` Hosting bundle. Keep the admin functions, app, DNS and
  Firebase Authentication unchanged. See the Hosting build and target in
  [the website release guide](website-staging-release.md).
- Use an approved phone number for one live test. Confirm the SMS arrives, the
  real code opens the role questions, and a labeled test enquiry reaches both
  the admin inbox and Aman's mailbox. Use email verification or WhatsApp if SMS
  delivery fails. Never mark a phone verified without a valid SMS code.
- The form's 30-second resend timer is not a spending cap. Review Firebase's
  [SMS limits](https://firebase.google.com/docs/auth/limits) and
  [pricing](https://cloud.google.com/identity-platform/pricing) before release.
  The server rate-limits proof exchange separately from email OTP; Firebase
  enforces SMS sending limits.

## Live release

Website Hosting version `56cc3affb5df1f1b` uses enquiry function revision
`websiteenquiry-00003-vev`. The phone popup and unverified-request rejection
were checked on the live site. The customer app and admin functions did not
change. A real SMS and the corresponding inbox entry and notification still
need a labeled visitor test.

## Service choices

Each role supports multiple choices. “All of the above” selects or clears the
individual choices and is never submitted as an option. The backend validates
and stores the selected labels separately, so the admin inbox and notification
show each selection. Older enquiries retain their original message text.

Releasing changes to service choices requires the website/admin Hosting bundle
and the `websiteEnquiry` and `readWebsiteEnquiries` functions. No migration or
change to the app's Authentication configuration is needed.
