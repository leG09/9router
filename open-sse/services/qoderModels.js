/**
 * Qoder model catalog compatibility layer.
 *
 * The protocol module is the single source of truth, while this legacy
 * service surface still resolves PAT credentials for existing callers.
 */

import {
  clearQoderCatalog,
  invalidateQoderCatalog,
  isQoderPat,
  resolvePatCredential,
  resolveQoderModels as resolveProtocolModels,
} from "../protocol/qoder/index.js";

export { clearQoderCatalog, invalidateQoderCatalog, isQoderPat };

/** Convert a Qoder PAT into credentials that can sign COSY requests. */
export async function resolveQoderCredentials(credentials, proxyOptions = null, signal = null, profile = null) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (!isQoderPat(raw)) return credentials;

  const protocolProfile =
    profile ||
    credentials?.protocolProfile ||
    credentials?.providerSpecificData?.protocolProfile ||
    (credentials?.provider === "qoderwork-cn" ? "cn-work" : null);
  const resolved = await resolvePatCredential(raw, {
    profile: protocolProfile,
    proxyOptions,
    signal,
  });

  return {
    ...credentials,
    accessToken: resolved.accessToken,
    apiKey: undefined,
    providerSpecificData: {
      authMethod: "pat",
      ...(credentials?.providerSpecificData || {}),
      userId: resolved.userId || credentials?.providerSpecificData?.userId || "",
      machineId: credentials?.providerSpecificData?.machineId || "",
    },
  };
}

export async function resolveQoderModels(credentials, options = {}) {
  let resolved;
  try {
    resolved = await resolveQoderCredentials(
      credentials,
      options.proxyOptions,
      options.signal,
      options.profile,
    );
  } catch (error) {
    options.log?.warn?.("QODER", `PAT exchange failed: ${error.message}`);
    return null;
  }
  return resolveProtocolModels(resolved, options);
}

export async function getQoderModelConfig(credentials, modelKey, options = {}) {
  const catalog = await resolveQoderModels(credentials, options);
  const config = catalog?.rawConfigs?.get(modelKey);
  return config ? { ...config, key: modelKey } : null;
}
