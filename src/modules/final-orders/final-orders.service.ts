import prisma from "../../prisma/client";

export async function listFinalOrders() {
  return prisma.order.findMany({
    where: { final_finance: { isNot: null } },
    orderBy: [{ service_start_at: "desc" }, { created_at: "desc" }],
    include: {
      final_finance: true,
      sheet_import_rows: true,
      // Merge: driver/car summary comes from the service-day lines.
      service_items: {
        orderBy: { sort_order: "asc" as const },
        select: {
          id: true,
          line_status: true,
          service_date: true,
          driver: { select: { id: true, name: true } },
          car: { select: { id: true, plate_number: true, model: true } },
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
      // Merge: the line IS the trip - include driver/car/expenses/reports here.
      service_items: {
        orderBy: { sort_order: "asc" as const },
        include: {
          driver: true,
          car: true,
          expenses: { orderBy: { created_at: "desc" as const } },
          reports: { orderBy: { created_at: "desc" as const } },
        },
      },
      reports: { orderBy: { created_at: "desc" } },
      invoices: { orderBy: { created_at: "desc" } },
      adjustments: { orderBy: { created_at: "desc" } },
      change_logs: { orderBy: { created_at: "desc" } },
    },
  });
}
