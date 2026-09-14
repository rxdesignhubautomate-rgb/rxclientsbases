// Owner-confirmed rule for this CRM: existing and newly added clients are
// opted in unless an explicit stop is recorded. This does not fabricate
// individual consent evidence or overwrite any stored opt-out.
export function businessOptedIn(contact) {
  return Boolean(contact) && !(contact.suppressed || contact.marketingOptOut ||
    contact.marketingConsent?.status === 'OPTED_OUT' || contact.optInStatus === 'OPTED_OUT' ||
    contact.doNotMarket || contact.stopAllCommunications || contact.status === 'BLOCKED');
}
