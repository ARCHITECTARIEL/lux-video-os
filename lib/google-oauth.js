const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleOAuthConfigured() {
  return Boolean(String(process.env.GOOGLE_CLIENT_ID || '').trim() && String(process.env.GOOGLE_CLIENT_SECRET || '').trim());
}

export function googleAuthorizationUrl({ redirectUri, state }) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) throw Object.assign(new Error('Google sign-in is not configured.'), { statusCode: 501 });
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'online');
  // Always show the account chooser rather than silently reusing whatever
  // Google session happens to be active in the browser -- this is a shared
  // login surface (family computer, shared workspace), not a single-user app.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeGoogleCode({ code, redirectUri }) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw Object.assign(new Error('Google sign-in is not configured.'), { statusCode: 501 });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error('Google sign-in could not verify your account.'), { statusCode: 502, providerStatus: response.status, providerCode: 'google_token_exchange_failed' });
  const tokens = JSON.parse(text);
  if (!tokens.access_token) throw Object.assign(new Error('Google sign-in did not return an access token.'), { statusCode: 502, providerCode: 'google_token_exchange_incomplete' });
  return tokens;
}

export async function fetchGoogleProfile(accessToken) {
  const response = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error('Google sign-in could not verify your account.'), { statusCode: 502, providerStatus: response.status, providerCode: 'google_userinfo_failed' });
  const profile = JSON.parse(text);
  // Google always sets email_verified for Google Accounts, but never trust an
  // unverified email as an account identifier -- it would let anyone claim a
  // mailbox they don't control.
  if (!profile.email || profile.email_verified !== true) throw Object.assign(new Error('Your Google account email is not verified.'), { statusCode: 401, failureCategory: 'VALIDATION' });
  return { email: String(profile.email).trim().toLowerCase(), name: String(profile.name || profile.email).trim(), sub: String(profile.sub || '') };
}
