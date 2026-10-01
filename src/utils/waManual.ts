/**
 * WhatsApp delivery mode. "bot" (default) sends through the wa-bot service as
 * before. "manual" (WA_DELIVERY=manual) works without the bot: customer
 * messages come back as a wa.me link the admin opens and sends from the
 * dashboard, and driver messages go to the driver app as push notifications.
 */
export function waManual(): boolean {
  return (process.env.WA_DELIVERY || "").trim().toLowerCase() === "manual";
}

/** wa.me link with the message prefilled (Indonesian numbers: 08… → 628…). */
export function waLink(phone: string, text: string): string {
  let digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
