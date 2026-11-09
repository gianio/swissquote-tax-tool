#!/usr/bin/env node
/*
 * Tiny CLI around the browser core, used by the test suite (and handy for a
 * quick check): reads a bank CSV and prints the eCH-0196 XML to stdout.
 * Swissquote exports are detected automatically; any other CSV goes through
 * the generic importer with auto-guessed column/type mapping.
 *
 *   node web/cli.js path/to/transactions.csv [taxYear] [canton]
 */
const fs = require("fs");
const core = require("./core.js");
const imp = require("./importers.js");

const path = process.argv[2];
if (!path) { console.error("usage: node web/cli.js <csv> [year] [canton]"); process.exit(2); }
const year = Number(process.argv[3]) || 2025;
const canton = process.argv[4] || "ZH";

const text = imp.decodeBytes(fs.readFileSync(path));
const table = imp.readTable(text);
let txns, balances = [];
if (imp.isSwissquote(table.header)) {
  txns = core.parseCsv(text);
} else {
  const r = imp.normalize(table, { mapping: imp.guessMapping(table.header) });
  txns = r.txns; balances = r.balances;
}
const res = core.classify(txns, "CH");
const out = core.buildXml(res, {
  taxYear: year, canton, clientNumber: "1", cashBalances: balances,
  fxRates: { CHF: 1, USD: 0.8, EUR: 0.93, CAD: 0.58, DKK: 0.125, GBP: 1.08, XAU: 3400 },
});
process.stdout.write(out.xml);
