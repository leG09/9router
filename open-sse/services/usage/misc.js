/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — session (5h) + weekly (7d) `usage` is a 0..1
 *   ratio (1.0 = limit reached, e.g. weekly 100% used). No reset timestamp exposed.
 * POST https://ollama.com/api/me — plan label (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const sessionRaw = limits.session?.usage;
    const weeklyRaw = limits.weekly?.usage;
    const sessionNum = Number(sessionRaw);
    const weeklyNum = Number(weeklyRaw);
    const hasSession = sessionRaw !== undefined && sessionRaw !== null && !Number.isNaN(sessionNum);
    const hasWeekly = weeklyRaw !== undefined && weeklyRaw !== null && !Number.isNaN(weeklyNum);

    if (!hasSession && !hasWeekly) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    const quotas = {};
    if (hasSession) quotas["Session (5h)"] = ratioQuota(sessionNum);
    if (hasWeekly) quotas["Weekly (7d)"] = ratioQuota(weeklyNum);

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit || limit.type !== "TOKENS_LIMIT") continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      quotas["session"] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U("qoder").url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}

// QoderWork CN credit balance (qwenwork.cn web API). Works for every account
// type, unlike gateway quota/usage whose user_quota is null on personal
// accounts. Response: { code: "ok", data: { balance, freeze_credit } }
const QODERWORK_CN_BALANCE_URL = "https://qwenwork.cn/user/balance";
const QODERWORK_CN_WEB_QUOTA_URL = "https://qwenwork.cn/user/quota";

function qoderworkCnWebHeaders(businessToken, providerSpecificData = {}) {
  const userId = providerSpecificData.userId || "";
  const organizationId = providerSpecificData.organizationId || "";
  const channel = new URLSearchParams({
    ...(userId ? { source_user_id: userId } : {}),
    ...(organizationId ? { source_org_id: organizationId } : {}),
    client: "qoderwork",
    sourceType: "QoderWork",
  }).toString();
  return {
    Accept: "application/json, text/plain, */*",
    Cookie: `token=${businessToken}`,
    "User-Agent": "Mozilla/5.0",
    "x-client-source": "desktop",
    ...(channel ? { "x-channel": channel } : {}),
  };
}

function qoderworkCnWebQuotaRecord(raw, balance, resetAt) {
  if (!raw || typeof raw !== "object") return null;
  const total = Number(raw.allowance ?? raw.total) || 0;
  const used = Number(raw.used) || 0;
  const quotaRemaining = Number(raw.remaining);
  const remaining = Number.isFinite(Number(balance))
    ? Math.max(0, Number(balance))
    : Number.isFinite(quotaRemaining) ? Math.max(0, quotaRemaining) : 0;
  if (!total && !used && !remaining) return null;
  const percentBase = Number.isFinite(quotaRemaining) ? quotaRemaining : remaining;
  return {
    total,
    used,
    remaining,
    unit: raw.unit || "credits",
    resetAt,
    remainingPercentage: total > 0
      ? Math.max(0, Math.min(100, (percentBase / total) * 100))
      : null,
  };
}

function qoderworkCnResetAt(raw) {
  if (!raw) return null;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function getQoderworkCnEnterpriseUsage(businessToken, providerSpecificData, proxyOptions) {
  const headers = qoderworkCnWebHeaders(businessToken, providerSpecificData);
  const [quotaResponse, balanceResponse] = await Promise.all([
    proxyAwareFetch(QODERWORK_CN_WEB_QUOTA_URL, { method: "GET", headers }, proxyOptions),
    proxyAwareFetch(QODERWORK_CN_BALANCE_URL, { method: "GET", headers }, proxyOptions),
  ]);

  if ([quotaResponse.status, balanceResponse.status].some((status) => status === 401 || status === 403)) {
    return {
      message: "QoderWork CN enterprise Web Token expired or unauthorized. Update it in the connection settings.",
      businessTokenExpired: true,
    };
  }
  if (!quotaResponse.ok || !balanceResponse.ok) {
    return {
      message: `QoderWork CN enterprise usage unavailable (quota ${quotaResponse.status}, balance ${balanceResponse.status}).`,
    };
  }

  const quotaBody = await quotaResponse.json().catch(() => null);
  const balanceBody = await balanceResponse.json().catch(() => null);
  const quotaData = quotaBody?.data && typeof quotaBody.data === "object" ? quotaBody.data : quotaBody;
  const balanceData = balanceBody?.data && typeof balanceBody.data === "object" ? balanceBody.data : balanceBody;
  if (!quotaData || !balanceData || (quotaBody?.code && quotaBody.code !== "ok") || (balanceBody?.code && balanceBody.code !== "ok")) {
    return { message: "QoderWork CN enterprise usage response was not valid JSON." };
  }

  const quota = quotaData.user_quota || quotaData.team_quota || quotaData.org_quota;
  const balance = Number(balanceData.balance);
  const freezeCredit = Number(balanceData.freeze_credit) || 0;
  const resetRaw = quotaData.next_used_reset_at || quota?.reset_at || null;
  const resetAt = qoderworkCnResetAt(resetRaw);
  const record = qoderworkCnWebQuotaRecord(quota, balance, resetAt);
  if (!record) return { message: "QoderWork CN enterprise quota record was missing." };

  return {
    plan: "Enterprise",
    quotas: { organization: record },
    balance: Number.isFinite(balance) ? balance : record.remaining,
    freezeCredit,
    organizationId: providerSpecificData.organizationId || null,
  };
}

function qoderworkCnPlanLabel(userType) {
  if (typeof userType !== "string" || !userType.trim()) return null;
  return userType
    .trim()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// CN quota/usage speaks snake_case ({user_quota, add_on_quota,
// org_resource_package, expires_at, ...}) — unlike Qoder intl's camelCase —
// so it needs its own parser.
function qoderworkCnQuotaRecord(quota, resetAt) {
  if (!quota || typeof quota !== "object") return null;
  const total = Number(quota.total) || 0;
  const used = Number(quota.used) || 0;
  const remaining = Number(quota.remaining) || 0;
  if (!total && !used && !remaining) return null;
  const remainingPercentage =
    total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : null;
  return {
    total,
    used,
    remaining,
    unit: quota.unit || "credits",
    resetAt,
    remainingPercentage,
  };
}

/**
 * QoderWork CN usage.
 *
 * Enterprise accounts require the short-lived qwenwork.cn business Web Token:
 * `/user/quota` supplies allowance/used and `/user/balance` supplies the live
 * remaining balance. Device OAuth tokens are personal-context tokens even when
 * userinfo reports an organization, so using one here returns a misleading
 * untouched personal wallet. Personal accounts retain the gateway/Bearer flow.
 */
export async function getQoderworkCnUsage(accessToken, proxyOptions = null, providerSpecificData = {}) {
  const businessToken = typeof providerSpecificData?.businessToken === "string"
    ? providerSpecificData.businessToken.trim()
    : "";
  const isEnterprise = providerSpecificData?.accountType === "enterprise" || !!providerSpecificData?.organizationId;

  if (businessToken) {
    const storedExpiry = Date.parse(providerSpecificData?.businessTokenExpiresAt || "");
    if (Number.isFinite(storedExpiry) && storedExpiry <= Date.now()) {
      return {
        message: "QoderWork CN enterprise Web Token expired. Update it in the connection settings.",
        businessTokenExpired: true,
      };
    }
    try {
      return await getQoderworkCnEnterpriseUsage(businessToken, providerSpecificData, proxyOptions);
    } catch (error) {
      return { message: `QoderWork CN enterprise usage unavailable: ${error.message}` };
    }
  }
  if (isEnterprise) {
    return {
      message: "QoderWork CN enterprise usage requires an enterprise Web Token. Add it in the connection settings.",
    };
  }
  if (!accessToken) {
    return { message: "QoderWork CN usage unavailable: no access token" };
  }

  let plan = null;
  const quotas = {};
  let meta = {};

  try {
    const response = await proxyAwareFetch(
      U("qoderwork-cn").url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          // CN quota endpoints expect the desktop product identity
          // (cn-work profile quotaUserAgent).
          "User-Agent": "QoderWork",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        message: `QoderWork CN token expired or unauthorized (${response.status}). Please re-authorize.`,
      };
    }

    if (response.ok) {
      const body = await response.json().catch(() => null);
      if (body && typeof body === "object") {
        plan = qoderworkCnPlanLabel(body.user_type);
        const expiresAtMs =
          Number.isFinite(Number(body.expires_at)) && Number(body.expires_at) > 0
            ? Number(body.expires_at)
            : null;
        const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
        const user = qoderworkCnQuotaRecord(body.user_quota, resetAt);
        if (user) quotas.user = user;
        const addOn = qoderworkCnQuotaRecord(body.add_on_quota, resetAt);
        if (addOn) quotas["add-on"] = addOn;
        const org = qoderworkCnQuotaRecord(body.org_resource_package, resetAt);
        if (org) quotas.organization = org;
        meta = {
          totalUsagePercentage: Number(body.total_usage_percentage) || 0,
          isQuotaExceeded: !!body.is_quota_exceeded,
          expiresAt: expiresAtMs,
        };
      }
    }
  } catch {
    // Network/proxy failure — try the balance endpoint below.
  }

  if (Object.keys(quotas).length > 0) {
    return { plan, quotas, ...meta };
  }

  // Personal accounts publish no quota records; the web balance endpoint is
  // the only usage source for them.
  try {
    const response = await proxyAwareFetch(
      QODERWORK_CN_BALANCE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        message: `QoderWork CN token expired or unauthorized (${response.status}). Please re-authorize.`,
      };
    }

    if (!response.ok) {
      return { message: `QoderWork CN connected. Usage fetch returned ${response.status}.` };
    }

    const body = await response.json().catch(() => null);
    if (!body || body.code !== "ok" || !body.data) {
      return { message: "QoderWork CN connected. Usage response was not JSON." };
    }

    const balance = Number(body.data.balance) || 0;
    const freezeCredit = Number(body.data.freeze_credit) || 0;

    return {
      plan,
      quotas: {
        // Personal balance has no published allowance. freeze_credit is
        // in-flight credit, not historical usage, so expose it as metadata
        // instead of presenting it as consumed quota.
        "Balance (credits)": {
          used: 0,
          total: balance,
          remaining: balance,
          remainingPercentage: 100,
          unit: "credits",
          resetAt: null,
          unlimited: false,
        },
      },
      balance,
      freezeCredit,
    };
  } catch (error) {
    return { message: `QoderWork CN connected. Unable to fetch usage: ${error.message}` };
  }
}
