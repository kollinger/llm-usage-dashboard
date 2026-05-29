# Apple Developer Program Status

## Current State

Date: 2026-05-29

Gerhard reached the Apple Developer enrollment page while signed in as `Gerhard Kollinger`.

Visible next step on the page:

- "Enroll with the Apple Developer app."
- Apple asks to open the Apple Developer app on iPhone, iPad, or Mac.
- In the app, use the Account tab and sign in to continue enrollment.

Gerhard does not currently want to pay the Apple Developer Program fee unless it is required for the distribution goal.

## Distribution Goal

The LLM Usage Dashboard should eventually be installable by friends/test users on macOS without requiring manual Gatekeeper/quarantine workarounds such as right-click-open, Security & Privacy override, or removing quarantine attributes.

## Current Conclusion

For that distribution goal, a paid Apple Developer Program membership is practically required.

Reason:

- normal external macOS distribution needs Developer ID signing and notarization,
- Developer ID certificates require Apple Developer Program membership,
- unsigned or ad-hoc-signed apps still trigger Gatekeeper friction on other Macs.

Current expected cost: Apple Developer Program membership, 99 USD/year, plus local taxes/currency handling in Apple's checkout.

## Next Steps

1. Decide whether to pay for Apple Developer Program membership.
2. Install/open the Apple Developer app on iPhone, iPad, or Mac.
3. In the app: Account tab -> sign in with Gerhard's Apple Account.
4. Enroll as Individual unless Gerhard explicitly wants an Organization account.
5. Complete identity verification and pay the annual membership fee.
6. After approval, create the later signing/notarization implementation issue:
   - Developer ID Application certificate,
   - Team ID,
   - notarization credentials or App Store Connect API key,
   - GitHub Actions secrets,
   - local signing test,
   - release build verification.

## Safety Notes

- Do not store Apple ID password, 2FA codes, private keys, app-specific passwords, certificates, or notarization secrets in Git, Multica comments, screenshots, or docs.
- Enrollment and payment must be done by Gerhard directly.
- This file is only project memory, not a credentials store.
