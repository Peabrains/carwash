import type { SupabaseClient } from "@supabase/supabase-js";

type ProviderRow = { id: string; name: string; description?: string; status: string };
type ProfileRow = { provider_id: string; marketplace_status: string; operations_suspended: boolean };
type OnboardingRow = { provider_id: string; status: string };
export type PublicProvider = { id: string; name: string; description: string; marketplaceVerified: boolean };

async function accessRows(db: SupabaseClient) {
  const [providersResult, profilesResult, onboardingResult] = await Promise.all([
    db.from("providers").select("id,name,description,status"),
    db.from("provider_profiles").select("provider_id,marketplace_status,operations_suspended"),
    db.from("provider_onboarding").select("provider_id,status"),
  ]);
  const error = providersResult.error || profilesResult.error || onboardingResult.error;
  if (error) throw new Error(`Supabase loading provider access failed: ${error.message}`);
  return {
    providers: (providersResult.data || []) as ProviderRow[],
    profiles: new Map(((profilesResult.data || []) as ProfileRow[]).map(row => [row.provider_id, row])),
    onboarding: new Map(((onboardingResult.data || []) as OnboardingRow[]).map(row => [row.provider_id, row])),
  };
}

function operational(provider: ProviderRow | undefined, profile: ProfileRow | undefined, onboarding: OnboardingRow | undefined) {
  return Boolean(provider?.status === "active" && profile && !profile.operations_suspended && ["ready", "active"].includes(onboarding?.status || ""));
}

export async function listMarketplaceProviders(db: SupabaseClient): Promise<PublicProvider[]> {
  const rows = await accessRows(db);
  return rows.providers.filter(provider => {
    const profile = rows.profiles.get(provider.id);
    return operational(provider, profile, rows.onboarding.get(provider.id)) && profile?.marketplace_status === "approved";
  }).sort((a, b) => a.name.localeCompare(b.name)).map(provider => ({ id: provider.id, name: provider.name, description: provider.description || "", marketplaceVerified: true }));
}

export async function assertPrivateProviderBookable(db: SupabaseClient, providerId: string): Promise<PublicProvider> {
  const rows = await accessRows(db); const provider = rows.providers.find(item => item.id === providerId); const profile = rows.profiles.get(providerId);
  if (!operational(provider, profile, rows.onboarding.get(providerId))) throw new Error("This provider is currently unavailable for booking.");
  return { id: provider!.id, name: provider!.name, description: provider!.description || "", marketplaceVerified: profile?.marketplace_status === "approved" };
}

export async function assertMarketplaceProviderBookable(db: SupabaseClient, providerId: string) {
  const provider = (await listMarketplaceProviders(db)).find(item => item.id === providerId);
  if (!provider) throw new Error("This provider is currently unavailable for marketplace booking.");
  return provider;
}
