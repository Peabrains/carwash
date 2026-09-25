export function cors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "content-type, authorization");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

type CustomerAuth = { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };

export async function verifiedCustomerId(request: Request, auth: CustomerAuth) {
  const token = bearerToken(request);
  if (!token) return null;
  const { data, error } = await auth.getUser(token);
  return error ? null : data.user?.id || null;
}

export function options() { return cors(new Response(null, { status: 204 })); }

export function json(value: unknown, status = 200) {
  return cors(Response.json(value, { status }));
}

export function requiredTenant(url: URL) {
  const providerId = url.searchParams.get("provider_id") || "";
  const locationId = url.searchParams.get("location_id") || "";
  if (!/^[a-z0-9-]+$/.test(providerId) || !/^[a-z0-9-]+$/.test(locationId)) return null;
  return { providerId, locationId };
}
