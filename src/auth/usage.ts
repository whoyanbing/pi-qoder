import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { QODER_MANAGE_URL, USAGE_TITLE, USER_AGENT, getUsageURL } from "../config.js";

interface QoderQuota {
  /** Personal plan limit. Absent for org/team packages, which use `cap`. */
  total?: number;
  /** Team/org package cap. */
  cap?: number;
  used: number;
  remaining: number;
  /** Fraction in [0, 1]. */
  percentage: number;
  unit: string;
  available?: boolean;
}

interface QoderUsageInfo {
  userType?: string;
  usageType?: string;
  totalUsagePercentage?: number;
  isQuotaExceeded?: boolean;
  expiresAt?: number;
  upgradeUrl?: string;
  userQuota?: QoderQuota;
  orgResourcePackage?: QoderQuota;
}

export interface QoderUsageBucket {
  id: string;
  label: string;
  usedDisplay: string;
  limitDisplay?: string;
  remainingDisplay?: string;
  percentDisplay?: string;
  unit?: string;
  resetAt?: string;
}

export interface QoderTeamBalance {
  used: number;
  cap: number;
  remaining: number;
  unit: string;
  available: boolean;
}

export interface QoderProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  manageUrl?: string;
  usageBuckets?: QoderUsageBucket[];
  teamBalance?: QoderTeamBalance;
  isQuotaExceeded?: boolean;
  upgradeUrl?: string;
  raw?: Record<string, unknown>;
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export async function fetchQoderUsage(credentials: OAuthCredentials): Promise<QoderProviderUsage> {
  const response = await fetch(getUsageURL(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.access}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Qoder usage: ${response.status} ${response.statusText}`);
  }

  const raw = (await response.json()) as QoderUsageInfo;
  const usageBuckets: QoderUsageBucket[] = [];
  const resetAt = raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined;

  if (raw.userQuota) {
    usageBuckets.push({
      id: "user-quota",
      label: "User Quota",
      usedDisplay: formatAmount(raw.userQuota.used),
      limitDisplay: formatAmount(raw.userQuota.total ?? raw.userQuota.cap ?? 0),
      remainingDisplay: formatAmount(raw.userQuota.remaining),
      percentDisplay: percent(raw.userQuota.percentage),
      unit: raw.userQuota.unit,
      resetAt,
    });
  }

  // Team balance: org packages report `cap` (not `total`) and may still exist
  // when the personal quota is exhausted.
  const org = raw.orgResourcePackage;
  const orgCap = org?.cap ?? org?.total ?? 0;
  const teamBalance =
    org && (orgCap > 0 || org.used > 0)
      ? {
          used: org.used,
          cap: orgCap,
          remaining: org.remaining,
          unit: org.unit,
          available: org.available ?? true,
        }
      : undefined;

  if (teamBalance && org) {
    usageBuckets.push({
      id: "team-balance",
      label: "Team Balance",
      usedDisplay: formatAmount(teamBalance.used),
      limitDisplay: formatAmount(teamBalance.cap),
      remainingDisplay: formatAmount(teamBalance.remaining),
      percentDisplay: percent(org.percentage),
      unit: teamBalance.unit,
      resetAt,
    });
  }

  const summary = teamBalance?.available
    ? `${formatAmount(teamBalance.remaining)} ${teamBalance.unit} remaining (team)`
    : raw.userQuota
      ? `${formatAmount(raw.userQuota.remaining)} ${raw.userQuota.unit} remaining`
      : "";

  return {
    summary,
    subscriptionTitle: USAGE_TITLE,
    resetAt,
    manageUrl: QODER_MANAGE_URL,
    usageBuckets,
    teamBalance,
    isQuotaExceeded: raw.isQuotaExceeded,
    upgradeUrl: raw.upgradeUrl,
    raw: raw as unknown as Record<string, unknown>,
  };
}
