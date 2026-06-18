/**
 * Race `work()` against a deadline so a wedged dependency resolves a `down`
 * health result instead of hanging the readiness probe (EVO-1226). A hung probe
 * would make Kubernetes/Cloud Run time out and flap the pod.
 */
export async function withTimeout<T>(
  work: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} health check timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
