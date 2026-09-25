export function oauthRedirectStarted(result) {
  return Boolean(result?.url);
}
