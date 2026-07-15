param(
  [Parameter(Mandatory = $true)]
  [string]$ResendApiKey,

  [Parameter(Mandatory = $true)]
  [string]$AuthFromEmail,

  [string]$Scope = 'lux-3035s-projects'
)

$ErrorActionPreference = 'Stop'

if ($ResendApiKey -notmatch '^re_') {
  throw 'RESEND_API_KEY should start with re_.'
}

if ($AuthFromEmail -notmatch '@') {
  throw 'AUTH_FROM_EMAIL must be a valid sender, e.g. Video OS Lite <hello@yourdomain.com>.'
}

$ResendApiKey | npx.cmd vercel env add RESEND_API_KEY production --scope $Scope
$AuthFromEmail | npx.cmd vercel env add AUTH_FROM_EMAIL production --scope $Scope

Write-Host 'Resend env vars added to Vercel production. Redeploy with: npx.cmd vercel --prod --yes --scope' $Scope