# Security Policy

## Supported Versions

CPS follows the current upstream version number and provides security fixes only for the latest published CPS release. Older releases should be upgraded before reporting a version-specific problem.

## Reporting a Vulnerability

Use the private **Report a vulnerability** form in the Security tab of [chenzetong/CPS](https://github.com/chenzetong/CPS/security). Do not open a public Issue containing credentials, account exports, SSH private keys, access or refresh tokens, private host addresses, logs with personal data, or a working exploit.

Please include the affected CPS version and platform, a minimal reproduction, impact, and sanitized logs. Maintainers will acknowledge a valid report through the private advisory and coordinate remediation before public disclosure.

## Repository Hygiene

Run `npm run security:scan` before publishing changes. GitHub Actions updater secrets must remain in repository Secrets; only the corresponding public key belongs in `src-tauri/tauri.conf.json`.
