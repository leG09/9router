import { QODERWORK_CN_CONFIG } from "../constants/oauth.js";

/**
 * QoderWork CN device flow. The gateway redirects the browser into the
 * qwenwork.cn OAuth UI, where login_challenge identifies the pending request.
 *
 * Everything region-specific lives in the protocol Profile ("cn-work"), so this
 * file only differs from qoder.js in three places: the config, the profile id,
 * and the synthetic-email prefix used for dedup.
 */
const qoderworkCn = {
  config: QODERWORK_CN_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const { QoderService } = await import("@/lib/oauth/services/qoder");
    const service = new QoderService({
      profile: config.protocolProfile,
    });
    const flow = await service.initiateDeviceFlow();
    const browserLoginUrl = await service.resolveBrowserLoginUrl(flow.verificationUriComplete);
    return {
      device_code: flow.nonce,
      user_code: flow.nonce.slice(0, 8).toUpperCase(),
      // Start the browser on qwenwork.cn/oauth2/auth. Its response sets the
      // CSRF cookie and redirects to /biz/signin with a server-issued challenge.
      verification_uri: browserLoginUrl,
      verification_uri_complete: browserLoginUrl,
      expires_in: 300,
      interval: 2,
      codeVerifier: flow.codeVerifier,
      _qoderNonce: flow.nonce,
      _qoderMachineId: flow.machineId,
      _qoderMachineToken: flow.machineToken,
    };
  },
  pollToken: async (config, deviceCode, codeVerifier, extraData) => {
    const { QoderService } = await import("@/lib/oauth/services/qoder");
    const svc = new QoderService({ profile: config.protocolProfile });
    const nonce = deviceCode || extraData?._qoderNonce;
    const verifier = codeVerifier || extraData?._qoderVerifier;
    if (!nonce || !verifier) {
      return {
        ok: false,
        data: { error: "invalid_request", error_description: "Missing nonce/verifier" },
      };
    }
    let result;
    try {
      result = await svc.pollDeviceToken({ nonce, codeVerifier: verifier });
    } catch (err) {
      return {
        ok: false,
        data: { error: "poll_failed", error_description: err.message },
      };
    }
    if (result.status === "pending") {
      return { ok: false, data: { error: "authorization_pending" } };
    }
    let accessToken = result.accessToken;
    let enterpriseIdentity = null;
    let accountContext = null;
    try {
      const identities = await svc.fetchCnOAuthIdentities(accessToken);
      enterpriseIdentity = identities.find((identity) => identity.status === "active") || null;
      if (enterpriseIdentity) {
        const switched = await svc.switchCnOAuthIdentity(accessToken, enterpriseIdentity);
        accessToken = switched.accessToken;
        enterpriseIdentity = switched.identity;
      }
      accountContext = await svc.fetchCnAccountContext(accessToken);
    } catch (err) {
      return {
        ok: false,
        data: {
          error: "identity_switch_failed",
          error_description: err.message,
        },
      };
    }
    const contextUser = accountContext?.user && typeof accountContext.user === "object"
      ? accountContext.user
      : accountContext || {};
    const userInfo = await svc.fetchUserInfo(accessToken);
    // expireTime is Unix-ms from parseExpiry (already defaults to +30d when the
    // upstream omits expiry). Floor at 1 day so a skewed clock can't truncate.
    const minSeconds = 24 * 60 * 60;
    const remainingSeconds = Math.floor((result.expireTime - Date.now()) / 1000);
    const expiresIn = Math.max(minSeconds, remainingSeconds);
    return {
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: result.refreshToken,
        expires_in: expiresIn,
        _qoderUserId: result.userId,
        _qoderMachineId: extraData?._qoderMachineId || "",
        _qoderMachineToken: extraData?._qoderMachineToken || extraData?._qoderMachineId || "",
        _qoderName: contextUser.name || contextUser.username || userInfo.name,
        _qoderEmail: contextUser.email || userInfo.email,
        _qoderOrganizationId: enterpriseIdentity?.organizationId || "",
        _qoderTeamId: enterpriseIdentity?.teamId || "",
        _qoderOrganizationName: enterpriseIdentity?.organizationName || "",
        _qoderOrganizationType: enterpriseIdentity?.organizationType || "",
        _qoderIdentityTarget: enterpriseIdentity ? "biz" : "c",
      },
    };
  },
  mapTokens: (tokens) => {
    const rawEmail = (tokens._qoderEmail || "").trim();
    const displayName = (tokens._qoderName || "").trim() || null;
    const userId = tokens._qoderUserId || "";
    // Dedup needs a non-empty email; CN accounts are phone-based and often
    // return none, so fall back to a stable synthetic id keyed on userId.
    const email = rawEmail || (userId ? `qoderwork-cn-user-${userId}` : null);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in,
      email,
      displayName,
      providerSpecificData: {
        authMethod: "device",
        userId,
        machineId: tokens._qoderMachineId || "",
        machineToken: tokens._qoderMachineToken || tokens._qoderMachineId || "",
        organizationId: tokens._qoderOrganizationId || "",
        teamId: tokens._qoderTeamId || "",
        organizationName: tokens._qoderOrganizationName || "",
        organizationType: tokens._qoderOrganizationType || "",
        identityTarget: tokens._qoderIdentityTarget || (tokens._qoderTeamId ? "biz" : "c"),
        accountType: tokens._qoderTeamId ? "enterprise" : "personal",
      },
    };
  },
};

export default qoderworkCn;
