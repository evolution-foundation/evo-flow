import { SetMetadata } from '@nestjs/common';

/**
 * Marks a handler/controller whose response must NOT be wrapped by
 * `ResponseTransformInterceptor` (EVO-1226). Used by the health endpoints so
 * `/health` and `/ready` return a raw, stable body — identical whether or not
 * the global interceptor is registered (worker modes don't register it), which
 * is what makes the contract consistent across every RUN_MODE.
 */
export const SKIP_RESPONSE_TRANSFORM = 'skipResponseTransform';
export const SkipResponseTransform = () =>
  SetMetadata(SKIP_RESPONSE_TRANSFORM, true);
