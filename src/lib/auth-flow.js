export function oauthRedirectStarted(result) {
  return Boolean(result?.url);
}

export function authorizationHeaders(accessToken = '') {
  return {
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}
