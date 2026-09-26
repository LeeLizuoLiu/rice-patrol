// Provider/model filters are optional. '*' is the entire wildcard, not a glob.
export function matchesRoute(filter, route) {
  return typeof route?.provider === 'string' && !!route.provider &&
    typeof route?.model === 'string' && !!route.model &&
    (filter.provider === '*' || filter.provider === route.provider) &&
    (filter.model === '*' || filter.model === route.model);
}
