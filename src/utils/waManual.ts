/**
 * WhatsApp delivery mode. "manual" (default) works without the wa-bot: customer
 * and driver messages come back as wa.me links the admin opens and sends from
 * the dashboard, and drivers also get a push in the driver app. "bot"
 * (WA_DELIVERY=bot) sends through the wa-bot service as before; kept only for
 * the transition while the bot is retired.
 */
export function waManual(): boolean {
  return (process.env.WA_DELIVERY || "").trim().toLowerCase() !== "bot";
}

/** wa.me link with the message prefilled (Indonesian numbers: 08… → 628…). */
export function waLink(phone: string, text: string): string {
  let digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
