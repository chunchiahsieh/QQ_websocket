/** Estimate the value shown by the upstream countdown from its last real update. */
export function remainingCountdownSeconds({
  deadline, receivedAt, initialValue, now, tickMilliseconds = 1000,
}: {
  deadline?: number;
  receivedAt?: number;
  initialValue?: number;
  now: number;
  tickMilliseconds?: number;
}): number | null {
  if (deadline === undefined || !Number.isFinite(deadline)) return null;
  if (initialValue !== undefined && Number.isFinite(initialValue)
      && receivedAt !== undefined && Number.isFinite(receivedAt)) {
    const elapsedTicks = Math.max(0, Math.floor((now - receivedAt) / tickMilliseconds));
    return Math.max(0, Math.ceil(initialValue) - elapsedTicks);
  }
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
