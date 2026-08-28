export function sanitizeQoderworkProviderSpecificData(providerSpecificData) {
  if (!providerSpecificData || typeof providerSpecificData !== "object") return providerSpecificData;
  const { businessToken, businessTokenExpiresAt, hasBusinessToken, ...safe } = providerSpecificData;
  return safe;
}
