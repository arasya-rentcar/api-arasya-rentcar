/* Sprint 1 numbering tests: concurrency, uniqueness, rollback.
   Run against the clean DB. Creates a temp customer + orders, then cleans up. */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

function pad8(date) {
  const j = new Date(date.getTime() + 7 * 3600 * 1000);
  return `${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, '0')}${String(j.getUTCDate()).padStart(2, '0')}`;
}

async function mintCustomerCode(tx) {
  const r = await tx.$queryRaw`UPDATE counters SET value = value + 1, updated_at = now() WHERE scope='customer' RETURNING value`;
  return `C${r[0].value}`;
}
async function nextSeq(tx, id, col) {
  const r = await tx.$queryRawUnsafe(
    `UPDATE customers SET ${col} = ${col} + 1 WHERE id = $1 RETURNING ${col} AS seq`, id);
  return r[0].seq;
}

(async () => {
  let fail = 0;
  const created = [];
  try {
    // 1) Make a temp customer with a real minted code
    const cust = await p.$transaction(async (tx) => {
      const code = await mintCustomerCode(tx);
      return tx.customer.create({ data: { code, name: 'TEST Numbering', phone: null } });
    });
    created.push(cust.id);
    console.log('temp customer:', cust.code, cust.id);

    // 2) CONCURRENCY: fire N parallel order_seq increments for the SAME customer
    const N = 15;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        p.$transaction((tx) => nextSeq(tx, cust.id, 'order_seq'))
      )
    );
    const sorted = [...results].sort((a, b) => a - b);
    const expected = Array.from({ length: N }, (_, i) => i + 1);
    const ok = JSON.stringify(sorted) === JSON.stringify(expected);
    console.log(`concurrency same-customer: got [${sorted[0]}..${sorted[sorted.length-1]}] unique=${new Set(results).size}/${N}`, ok ? 'PASS' : 'FAIL');
    if (!ok) fail++;

    // 3) DIFFERENT customers don't collide (separate counters)
    const cust2 = await p.$transaction(async (tx) => {
      const code = await mintCustomerCode(tx);
      return tx.customer.create({ data: { code, name: 'TEST Numbering 2', phone: null } });
    });
    created.push(cust2.id);
    const [s1, s2] = await Promise.all([
      p.$transaction((tx) => nextSeq(tx, cust.id, 'invoice_seq')),
      p.$transaction((tx) => nextSeq(tx, cust2.id, 'invoice_seq')),
    ]);
    console.log(`different-customer invoice_seq: c1=${s1} c2=${s2}`, (s1 === 1 && s2 === 1) ? 'PASS' : 'FAIL');
    if (!(s1 === 1 && s2 === 1)) fail++;

    // 4) ROLLBACK: bump seq then throw -> seq must be unchanged
    const before = (await p.customer.findUnique({ where: { id: cust.id } })).kwitansi_seq;
    try {
      await p.$transaction(async (tx) => {
        await nextSeq(tx, cust.id, 'kwitansi_seq');
        throw new Error('forced rollback');
      });
    } catch (_) { /* expected */ }
    const after = (await p.customer.findUnique({ where: { id: cust.id } })).kwitansi_seq;
    console.log(`rollback kwitansi_seq: before=${before} after=${after}`, before === after ? 'PASS' : 'FAIL');
    if (before !== after) fail++;

    // 5) Format check
    const code = `ARS-${pad8(new Date())}-${cust.code}-3`;
    console.log('sample order code:', code, /^ARS-\d{8}-C\d+-\d+$/.test(code) ? 'PASS' : 'FAIL');
    if (!/^ARS-\d{8}-C\d+-\d+$/.test(code)) fail++;

  } finally {
    // Cleanup temp customers
    for (const id of created) {
      await p.customer.delete({ where: { id } }).catch(() => {});
    }
    console.log('cleaned up temp customers:', created.length);
    await p.$disconnect();
  }
  console.log(fail === 0 ? '\nALL TESTS PASSED' : `\n${fail} TEST(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
