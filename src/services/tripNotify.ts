import prisma from "../prisma/client";
import { pushToDriver } from "./push.service";

/** Driver app notifications when trips are given to / taken from a driver. */
function when(d: Date | null, t: Date | null): string {
  const at = t ?? d;
  if (!at) return "";
  const day = at.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", weekday: "short", day: "numeric", month: "short" });
  const time = t ? at.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }) : "";
  return time ? `${day}, ${time}` : day;
}

export async function notifyNewTrips(driverId: string, lineIds: string[]): Promise<void> {
  try {
    if (!lineIds.length) return;
    const lines = await prisma.orderServiceItem.findMany({
      where: { id: { in: lineIds }, driver_id: driverId, is_external: false },
      orderBy: [{ service_date: "asc" }, { start_at: "asc" }],
      select: { id: true, service_date: true, start_at: true, pickup_location: true, dropoff_location: true },
    });
    if (!lines.length) return;
    const first = lines[0];
    await pushToDriver(driverId, {
      title: lines.length === 1 ? "Tugas baru" : `${lines.length} tugas baru`,
      body:
        lines.length === 1
          ? `${when(first.service_date, first.start_at)} · ${first.pickup_location} → ${first.dropoff_location}`
          : `Mulai ${when(first.service_date, first.start_at)} · ${first.pickup_location}`,
      data: { type: "trip_assigned", line_id: first.id },
    });
  } catch (err) {
    console.error("notifyNewTrips failed", err);
  }
}

export async function notifyTripsRemoved(driverId: string, lineIds: string[]): Promise<void> {
  try {
    if (!lineIds.length) return;
    await pushToDriver(driverId, {
      title: "Tugas dialihkan",
      body:
        lineIds.length === 1
          ? "Satu tugas Anda dialihkan ke driver lain. Cek daftar tugas."
          : `${lineIds.length} tugas Anda dialihkan ke driver lain. Cek daftar tugas.`,
      data: { type: "trip_updated", line_id: lineIds[0] },
    });
  } catch (err) {
    console.error("notifyTripsRemoved failed", err);
  }
}

/** The admin moved the date, time or place of trips already given to a driver. */
export async function notifyTripsChanged(driverId: string, lineIds: string[]): Promise<void> {
  try {
    if (!lineIds.length) return;
    const lines = await prisma.orderServiceItem.findMany({
      where: { id: { in: lineIds }, driver_id: driverId, is_external: false },
      orderBy: [{ service_date: "asc" }, { start_at: "asc" }],
      select: { id: true, service_date: true, start_at: true, pickup_location: true },
    });
    if (!lines.length) return;
    const first = lines[0];
    await pushToDriver(driverId, {
      title: lines.length === 1 ? "Jadwal tugas diubah" : `${lines.length} jadwal tugas diubah`,
      body: `${when(first.service_date, first.start_at)} · jemput di ${first.pickup_location}. Buka tugas untuk melihat perubahan.`,
      data: { type: "trip_changed", line_id: first.id },
    });
  } catch (err) {
    console.error("notifyTripsChanged failed", err);
  }
}
