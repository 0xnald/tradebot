// Token age from a deployment timestamp — see the TokenAgeCategory doc
// comment in src/types/domain.ts for the documented category thresholds.

import type { TokenAge, TokenAgeCategory } from "../types/domain.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function categorize(ageSeconds: number): TokenAgeCategory {
  if (ageSeconds < 10 * MINUTE) return "BRAND_NEW";
  if (ageSeconds < HOUR) return "VERY_NEW";
  if (ageSeconds < DAY) return "NEW";
  if (ageSeconds < 30 * DAY) return "ESTABLISHED";
  return "MATURE";
}

/** `deployedAt` is `null`/`undefined` when the deployment timestamp genuinely isn't known — never fabricated as "now" or epoch-0. */
export function computeTokenAge(deployedAt: string | null | undefined, now: Date = new Date()): TokenAge {
  if (!deployedAt) {
    return { deployedAt: null, ageSeconds: null, ageMinutes: null, ageHours: null, ageCategory: "UNKNOWN" };
  }

  const deployedTime = new Date(deployedAt).getTime();
  if (Number.isNaN(deployedTime)) {
    return { deployedAt: null, ageSeconds: null, ageMinutes: null, ageHours: null, ageCategory: "UNKNOWN" };
  }

  const ageSeconds = Math.max(0, (now.getTime() - deployedTime) / 1000);

  return {
    deployedAt,
    ageSeconds,
    ageMinutes: ageSeconds / 60,
    ageHours: ageSeconds / 3600,
    ageCategory: categorize(ageSeconds),
  };
}
