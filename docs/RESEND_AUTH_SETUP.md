# Video OS Lite Email Sign-In Setup

Magic-link auth is implemented, but production email delivery requires Resend configuration in Vercel.

## Required Vercel env vars

- `RESEND_API_KEY`: Resend API key. It should start with `re_`.
- `AUTH_FROM_EMAIL`: Verified sender, for example `Video OS Lite <hello@yourdomain.com>`.

## Recommended Resend setup

1. Create or open a Resend account.
2. Verify the sending domain you want to use.
3. Create an API key with email-send access.
4. Add the two env vars to Vercel production.
5. Redeploy production.
6. Test `/api/video-os-lite/auth-request` from the public site.

## Helper command

From `C:\Users\ariel\lux-video-os`:

```powershell
.\scripts\configure-resend-vercel.ps1 -ResendApiKey "re_..." -AuthFromEmail "Video OS Lite <hello@yourdomain.com>"
```

The script pipes values directly into `vercel env add`; it does not write the secret into the repo.

## Current behavior when missing

If either env var is absent, `/api/video-os-lite/auth-request` returns a setup error and does not create a magic-token record. This prevents dead sign-in links and junk auth records.