# Search-result favicon

The website previously declared only a 54 × 48 SVG favicon and used the same SVG
for Apple touch icons. `/favicon.png` and `/favicon.ico` returned 404. Google
requires a square favicon and currently lists PNG/ICO among its supported search
formats. The existing TrustKeyper monogram is preserved, padded to a square,
and exported as a 96 × 96 PNG, a 16/32/48 ICO, and a 180 × 180 Apple touch PNG.
All nine public pages share `_partials/icons.html` and stable icon URLs.

The PNG/ICO files are source assets rather than a build-time runtime
dependency. To regenerate them from `website/site/src/favicon.svg`, run
`node scripts/generate-website-icons.cjs` with Sharp available to Node, or set
`TRUSTKEYPER_SHARP_MODULE` to an existing Sharp module directory. The normal
website build copies these assets; it does not need Sharp.

Verification: `node --test scripts/test/website-favicon.test.cjs` checks PNG
dimensions/signatures, each embedded ICO image, generated page links and copied
assets. All 22 website/tooling tests passed. The existing admin bundle was
compared byte-for-byte before publication; this change does not rebuild it or
deploy the customer app, functions, DNS, billing or authentication configuration.

Publishing fixes the website declaration, not Google's cached search appearance.
Google controls whether and when it displays the favicon. After deployment,
inspect `https://trustkeyper.com/` in the verified Google Search Console property
and request indexing if available. Google describes recrawling as taking several
days to several weeks, and does not guarantee displaying a favicon even when
the guidelines are met.

Reference: https://developers.google.com/search/docs/appearance/favicon-in-search
