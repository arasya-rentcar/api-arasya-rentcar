import { Prisma } from "@prisma/client";
import prisma from "../prisma/client";
import { logger } from "../config/logger";

/**
 * Push notifications to the mobile app through Expo's push service (free,
 * no credentials needed server-side). Best-effort: never throws, so callers
 * can fire and forget. Tokens Expo reports as unregistered are removed.
 */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Overridable for local testing.
const EXPO_PUSH_URL = process.env.EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send";

async function sendToTokens(tokens: string[], msg: PushMessage): Promise<void> {
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        batch.map((to) => ({
          to,
          title: msg.title,
          body: msg.body,
          data: msg.data ?? {},
          sound: "default",
          priority: "high",
          channelId: "trips",
        })),
      ),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "expo push rejected");
      continue;
    }
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    const dead = (json.data ?? [])
      .map((t, idx) => (t.status === "error" && t.details?.error === "DeviceNotRegistered" ? batch[idx] : null))
      .filter((t): t is string => !!t);
    if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
  }
}

export async function pushToUsers(userIds: string[], msg: PushMessage): Promise<void> {
  try {
    if (!userIds.length) return;
    const devices = await prisma.deviceToken.findMany({
      where: { user_id: { in: userIds } },
      select: { token: true },
    });
    await sendToTokens(devices.map((d) => d.token), msg);
  } catch (err) {
    logger.error({ err }, "push to users failed");
  }
}

/**
 * Push to a driver's phones and keep it in the app inbox (DriverNotification),
 * so it can still be read when the push was missed (no signal, notifications
 * off, phone replaced). `data.type` is the notification type.
 */
export async function pushToDriver(driverId: string, msg: PushMessage): Promise<void> {
  try {
    const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { user_id: true } });
    if (!driver) return;
    const type = typeof msg.data?.type === "string" ? msg.data.type : "info";
    // The inbox row is best-effort: the push still goes out if it fails.
    let notificationId: string | null = null;
    try {
      const row = await prisma.driverNotification.create({
        data: {
          driver_id: driverId,
          type,
          title: msg.title,
          body: msg.body,
          data: (msg.data ?? {}) as Prisma.InputJsonValue,
        },
      });
      notificationId = row.id;
    } catch (err) {
      logger.error({ err }, "driver inbox write failed");
    }
    await pushToUsers([driver.user_id], {
      ...msg,
      data: { ...(msg.data ?? {}), ...(notificationId ? { notification_id: notificationId } : {}) },
    });
  } catch (err) {
    logger.error({ err }, "push to driver failed");
  }
}

export async function pushToAdmins(msg: PushMessage): Promise<void> {
  try {
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    await pushToUsers(admins.map((a) => a.id), msg);
  } catch (err) {
    logger.error({ err }, "push to admins failed");
  }
}
