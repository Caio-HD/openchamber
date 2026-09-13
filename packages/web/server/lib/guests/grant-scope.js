import { resolveIntegrationApi } from '@openchamber/sdk';

// What a grant covered when the user approved it. `filesystem` is the
// declared pattern list, `network` the API origin, `service` the exec names
// and socket ids the dialog showed. A newer package that changes any of
// these has not been approved for that capability, whatever the stored
// grant list says, so the card asks again and the proxies refuse meanwhile.

const sortedUnique = (values) => [...new Set(values)].sort();

/**
 * @param {{ filesystem?: string[], integration?: object, service?: { permissions?: { exec?: string[], sockets?: Array<{ id: string }> } } }} guest
 * @returns {{ filesystem?: string[], apiOrigin?: string, service?: { exec: string[], sockets: string[] } }}
 */
export const guestGrantScope = (guest) => {
  const scope = {};
  if (Array.isArray(guest.filesystem) && guest.filesystem.length > 0) {
    scope.filesystem = sortedUnique(guest.filesystem);
  }
  if (guest.integration) {
    const api = resolveIntegrationApi(guest.integration);
    if (api?.apiOrigin) {
      scope.apiOrigin = api.apiOrigin;
    }
  }
  if (guest.service) {
    scope.service = {
      exec: sortedUnique(guest.service.permissions?.exec ?? []),
      sockets: sortedUnique((guest.service.permissions?.sockets ?? []).map((binding) => binding.id)),
    };
  }
  return scope;
};

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * The grants that still hold for the package as it is now. A scoped
 * capability (`filesystem`, `network`, `service`) only counts when the stored
 * scope equals the current one; without a stored scope it never counts.
 * @param {string[]} granted
 * @param {ReturnType<typeof guestGrantScope> | undefined} stored
 * @param {ReturnType<typeof guestGrantScope>} current
 */
export const effectiveGrants = (granted, stored, current) => granted.filter((capability) => {
  if (capability === 'filesystem') {
    return Boolean(stored?.filesystem) && sameList(stored.filesystem, current.filesystem ?? []);
  }
  if (capability === 'network') {
    return Boolean(stored?.apiOrigin) && stored.apiOrigin === current.apiOrigin;
  }
  if (capability === 'service') {
    return Boolean(stored?.service)
      && sameList(stored.service.exec, current.service?.exec ?? [])
      && sameList(stored.service.sockets, current.service?.sockets ?? []);
  }
  return true;
});
