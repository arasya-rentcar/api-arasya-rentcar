import prisma from "../../prisma/client";

export async function listFinalOrders() {
  return prisma.order.findMany({
    where: { final_finance: { isNot: null } },
    orderBy: [{ service_start_at: "desc" }, { created_at: "desc" }],
    include: {
      final_finance: true,
      sheet_import_rows: true,
      trip: {
        select: {
          id: true,
          current_status: true,
          driver: { select: { name: true } },
          car: { select: { plate_number: true, model: true } },
        },
      },
    },
  });
}

export async function getFinalOrderById(id: string) {
  return prisma.order.findFirst({
    where: { id, final_finance: { isNot: null } },
    include: {
      final_finance: true,
      sheet_import_rows: true,
      customers: true,
      service_items: true,
      trip: { include: { driver: true, car: true, logs: true, expenses: true, reports: true } },
      reports: { orderBy: { created_at: "desc" } },
      invoices: { orderBy: { created_at: "desc" } },
      adjustments: { orderBy: { created_at: "desc" } },
      change_logs: { orderBy: { created_at: "desc" } },
    },
  });
}
