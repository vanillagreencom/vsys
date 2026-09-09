import type { Config } from "../config/config";

/**
 * Every setting collection reads, and the only owner of that fact. The runtime
 * rebuilds the collector when one of them changes, so a new collection setting
 * must be declared here. Settings the dashboard reads while rendering, and the
 * notification rules the runtime applies after a sample, are not collection
 * settings and must stay out: rebuilding discards counters and alert state.
 */
export const collectionKeys = [
  "cgroupRoot",
  "cgroupTop",
  "procRoot",
  "btrfsRoot",
  "sysBlockRoot",
  "watchedSlices",
  "agentSlice",
  "agentTools",
  "excludeArgv",
  "capMarkers",
  "linkerNames",
  "compilerNames",
  "sccacheNames",
  "jobserverEnv",
  "memoryFloor",
  "pressureAmber",
  "pressureHoldSeconds",
  "laneNaming",
  "laneEnv",
  "laneNameParts",
  "accountEnv",
  "paneEnv",
  "titleEnv",
  "scratchDirs",
  "scratchQuota",
  "scratchRefreshMs",
  "btrfsMounts",
  "scrubDir",
  "smartDir",
] as const;
/**
 * The settings a collection function may read. Every entry point collection
 * reaches takes this type, so reading an undeclared setting is a compile error
 * rather than a collector left stale until the next restart.
 */
export type CollectionConfig = Pick<Config, (typeof collectionKeys)[number]>;
