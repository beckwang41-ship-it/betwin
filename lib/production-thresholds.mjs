export function modelConfigIsCurrent(
  config,
  { verifiedMatches, sourceUpdatedAt, matchingVersion },
) {
  return Boolean(
    config?.data?.verifiedMatches === verifiedMatches &&
      config?.data?.sourceUpdatedAt &&
      config.data.sourceUpdatedAt === sourceUpdatedAt &&
      config?.methodology?.matchingVersion === matchingVersion,
  );
}

export function resolveProductionThresholds(
  config,
  state,
  defaults,
  markets = ["spf", "hhad", "goals"],
) {
  const stale = !modelConfigIsCurrent(config, state);
  return {
    stale,
    values: Object.fromEntries(
      markets.map((market) => {
        const configured = Number(config?.markets?.[market]?.threshold);
        return [
          market,
          !stale && Number.isFinite(configured) && configured > 0
            ? configured
            : Number(defaults[market]),
        ];
      }),
    ),
  };
}
