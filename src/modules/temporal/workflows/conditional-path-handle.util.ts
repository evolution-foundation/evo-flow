// Legacy conditional edges were saved with a `path-` prefixed sourceHandle
// (`path-<id>`), while the Conditional node emits the raw `path.id` (EVO-1902).
// To keep journeys authored before that fix routing correctly, strip a single
// optional leading `path-` from both the edge handle and the node handle before
// comparing — so legacy (`path-<id>`) and new (`<id>`) both match.
//
// This normalization is scoped to the conditional path handle: a Split handle
// (`split-variant-<id>`) does not start with `path-`, so it is returned
// unchanged and Split keeps matching on its full prefixed handle on both sides.
// `else` and any other non-prefixed handle are likewise returned as-is.
// (EVO-1922)
export const CONDITIONAL_PATH_HANDLE_PREFIX = 'path-';

export function normalizeConditionalPathHandle(handle: unknown): string {
  if (typeof handle !== 'string') return '';
  return handle.startsWith(CONDITIONAL_PATH_HANDLE_PREFIX)
    ? handle.slice(CONDITIONAL_PATH_HANDLE_PREFIX.length)
    : handle;
}
