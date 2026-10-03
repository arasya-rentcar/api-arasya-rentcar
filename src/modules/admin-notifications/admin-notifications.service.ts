import { Prisma } from "@prisma/client";
import prisma from "../../prisma/client";

/**
 * Dashboard notification feed (written by services/adminNotify.ts). Read state
 * is per admin: a row in admin_notification_reads per (notification, admin).
 * Only the last 30 days are listed and counted.
 */
const RETENTION_MS = 30 * 86400000;
const since = () => new Date(Date.now() - RETENTION_MS);

const unreadWhere = (userId: string): Prisma.AdminNotificationWhereInput => ({
  created_at: { gte: since() },
  reads: { none: { user_id: userId } },
});

export const unreadCount = (userId: string) => prisma.adminNotification.count({ where: unreadWhere(userId) });

export async function listAdminNotifications(
  userId: string,
  q: { limit: number; before?: string; unread?: boolean },
) {
  const where: Prisma.AdminNotificationWhereInput = {
    created_at: { gte: since(), ...(q.before ? { lt: new Date(q.before) } : {}) },
    ...(q.unread ? { reads: { none: { user_id: userId } } } : {}),
  };
  const [rows, unread_count] = await Promise.all([
    prisma.adminNotification.findMany({
      where,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      take: q.limit,
      include: { reads: { where: { user_id: userId }, select: { id: true } } },
    }),
    unreadCount(userId),
  ]);
  return {
    items: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      order_id: n.order_id,
      order_code: n.order_code,
      service_item_id: n.service_item_id,
      driver_id: n.driver_id,
      driver_request_id: n.driver_request_id,
      expense_id: n.expense_id,
      link: n.link,
      created_at: n.created_at,
      read: n.reads.length > 0,
    })),
    unread_count,
  };
}

/** Cheap poll for the bell (the dashboard asks every 15 s). */
export async function notificationsSummary(userId: string) {
  const [unread_count, latest] = await Promise.all([
    unreadCount(userId),
    prisma.adminNotification.findFirst({
      where: { created_at: { gte: since() } },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      select: { id: true, created_at: true },
    }),
  ]);
  return { unread_count, latest_id: latest?.id ?? null, latest_at: latest?.created_at ?? null };
}

/** Mark some (ids) or all of the listed notifications read for this admin. */
export async function markAdminNotificationsRead(userId: string, input: { ids?: string[]; all?: boolean }) {
  const rows = await prisma.adminNotification.findMany({
    where: input.all ? unreadWhere(userId) : { id: { in: input.ids ?? [] } },
    select: { id: true },
  });
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.adminNotificationRead.createMany({
      data: rows.slice(i, i + 1000).map((n) => ({ notification_id: n.id, user_id: userId })),
      skipDuplicates: true,
    });
  }
  return { unread_count: await unreadCount(userId) };
}
