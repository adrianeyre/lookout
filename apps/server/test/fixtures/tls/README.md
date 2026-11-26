# TLS test fixtures

Test-only certificates for `apps/server/src/sites/check.test.ts`. The keys protect nothing.

- `ca.pem`: "Lookout Test CA", valid 2026-01-01 to 2046-01-01. Its key was deleted after signing.
- `leaf.pem` / `leaf-key.pem`: `secure.example` and `www.secure.example`, valid 2026-01-01 to 2036-01-01.
- `leaf-expired.pem` / `leaf-expired-key.pem`: the same names, valid 2020-01-01 to 2021-01-01.

Made with OpenSSL's `req -x509 -not_before/-not_after` and `x509 -req`, P-256 keys. The fixed
dates let tests use fixed clocks. Playwright makes its own certificate at startup instead
(`apps/server/test-support/fake-site.ts`), so it really expires in 5 days.
