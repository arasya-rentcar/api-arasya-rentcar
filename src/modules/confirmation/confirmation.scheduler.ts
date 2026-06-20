/**
 * #A1/#A2 — H-1 daily confirmation sweep scheduler (config-driven).
 *
 * Fires once per day at CONFIRMATION_SWEEP_TIME (local WIB, "HH:MM") and sends
 * trip-team confirmations for tomorrow's (WIB) eligible internal lines. Pure
 * setTimeout self-scheduling — no external cron dependency. The time is NOT
 * hardcoded; change CONFIRMATION_SWEEP_TIME (default 17:00) to move it.
 */
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { runDailyConfirmationSweep } from './confirmation.service';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Ms from `now` until the next WIB HH:MM occurrence. */
function msUntilNextWib(hh: number, mm: number, now: Date = new Date()): number {
  const wibNow = new Date(now.getTime() + WIB_OFFSET_MS);
  const target = new Date(
    Date.UTC(
      wibNow.getUTCFullYear(),
      wibNow.getUTCMonth(),
      wibNow.getUTCDate(),
      hh,
      mm,
      0,
      0,
    ),
  );
  // target is a "WIB wall-clock" instant expressed via UTC fields; convert back
  // to a real instant by subtracting the offset.
  let targetInstant = target.getTime() - WIB_OFFSET_MS;
  if (targetInstant <= now.getTime()) {
    targetInstant += 24 * 60 * 60 * 1000; // tomorrow
  }
  return targetInstant - now.getTime();
}

let timer: NodeJS.Timeout | null = null;

export function startConfirmationScheduler(): void {
  if (!env.CONFIRMATION_SWEEP_ENABLED) {
    logger.info('[confirmation] daily sweep disabled (CONFIRMATION_SWEEP_ENABLED=false)');
    return;
  }
  const [hhStr, mmStr] = env.CONFIRMATION_SWEEP_TIME.split(':');
  const hh = Number(hhStr);
  const mm = Number(mmStr);

  const scheduleNext = () => {
    const delay = msUntilNextWib(hh, mm);
    logger.info(
      `[confirmation] next H-1 sweep in ${Math.round(delay / 60000)} min (at ${env.CONFIRMATION_SWEEP_TIME} WIB)`,
    );
    timer = setTimeout(async () => {
      try {
        const summary = await runDailyConfirmationSweep();
        logger.info(
          { summary },
          `[confirmation] H-1 sweep done: ${summary.sent} sent / ${summary.skipped} skipped / ${summary.failed} failed (tomorrow ${summary.date_wib})`,
        );
      } catch (e) {
        logger.error({ err: (e as Error).message }, '[confirmation] H-1 sweep failed');
      } finally {
        scheduleNext(); // re-arm for the following day
      }
    }, delay);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
  };

  scheduleNext();
}

export function stopConfirmationScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
