import ExcelJS from "exceljs";
import JSZip from "jszip";
import path from "node:path";
import { BusinessError, fenToYuan, milliToQuantity } from "./domain.mjs";

function decodeXml(value) {
  return String(value ?? "").replace(/&#(x?[0-9a-f]+);|&(amp|lt|gt|quot|apos);/gi, (match, numeric, named) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.replace(/^x/i, ""), numeric[0].toLowerCase() === "x" ? 16 : 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named.toLowerCase()];
  });
}

function xmlAttr(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function parseSharedStrings(xml) {
  const values = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    const parts = [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    values.push(parts.join(""));
  }
  return values;
}

function parseCells(xml, sharedStrings, allowedColumns) {
  const cells = new Map();
  for (const match of xml.matchAll(/<c\s([^>]*\br="([A-Z]+)(\d+)"[^>]*)>([\s\S]*?)<\/c>/g)) {
    const [, attributes, column, rowText, body] = match;
    if (!allowedColumns.has(column)) continue;
    const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
    const inlineParts = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    let value = valueMatch ? decodeXml(valueMatch[1]) : inlineParts.join("");
    if (xmlAttr(attributes, "t") === "s" && value !== "") value = sharedStrings[Number(value)] ?? "";
    cells.set(`${column}${rowText}`, value);
  }
  return cells;
}

async function rawCatalogSheets(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new BusinessError("不是有效的xlsx文件", "IMPORT_FORMAT_ERROR");
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = sharedXml ? parseSharedStrings(sharedXml) : [];
  const rels = new Map();
  for (const match of relsXml.matchAll(/<Relationship\s([^>]+?)\/?>(?:<\/Relationship>)?/g)) {
    rels.set(xmlAttr(match[1], "Id"), xmlAttr(match[1], "Target"));
  }
  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<sheet\s([^>]+?)\/?>(?:<\/sheet>)?/g)) {
    const name = xmlAttr(match[1], "name");
    const relId = xmlAttr(match[1], "r:id");
    const target = rels.get(relId);
    if (name && target) sheets.set(name, path.posix.normalize(`xl/${target}`));
  }
  const productPath = sheets.get("商品库");
  const customerPath = sheets.get("客户库");
  if (!productPath || !customerPath) throw new BusinessError("Excel中必须包含“商品库”和“客户库”工作表", "IMPORT_FORMAT_ERROR");
  const productXml = await zip.file(productPath)?.async("string");
  const customerXml = await zip.file(customerPath)?.async("string");
  if (!productXml || !customerXml) throw new BusinessError("无法读取商品库或客户库", "IMPORT_FORMAT_ERROR");
  return {
    products: parseCells(productXml, sharedStrings, new Set(["A", "B", "C"])),
    customers: parseCells(customerXml, sharedStrings, new Set(["A"])),
  };
}

export async function previewCatalogWorkbook(buffer) {
  const sheets = await rawCatalogSheets(buffer);

  const products = [];
  for (let row = 2; row <= 10000; row++) {
    const name = String(sheets.products.get(`A${row}`) ?? "").trim();
    const unit = String(sheets.products.get(`B${row}`) ?? "").trim();
    const rawPrice = sheets.products.get(`C${row}`) ?? "";
    if (!name && !unit && (rawPrice === "" || rawPrice == null)) continue;
    if (!name || !unit || rawPrice === "" || rawPrice == null || Number.isNaN(Number(rawPrice))) {
      throw new BusinessError(`商品库第${row}行缺少名称、单位或有效价格`, "IMPORT_FORMAT_ERROR");
    }
    products.push({ sourceRow: row, name, unit, price: Number(rawPrice).toFixed(2) });
  }

  const customers = [];
  for (let row = 2; row <= 10000; row++) {
    const raw = sheets.customers.get(`A${row}`);
    const name = String(raw ?? "").trim();
    if (!name) continue;
    customers.push({ sourceRow: row, name, printSort: customers.length + 1, code: String(customers.length + 1).padStart(3, "0") });
  }

  const productGroups = new Map();
  for (const product of products) {
    const list = productGroups.get(product.name) || [];
    list.push(product);
    productGroups.set(product.name, list);
  }
  const customerGroups = new Map();
  for (const customer of customers) {
    const list = customerGroups.get(customer.name) || [];
    list.push(customer);
    customerGroups.set(customer.name, list);
  }

  const issues = {
    duplicateProducts: [...productGroups.entries()].filter(([, rows]) => rows.length > 1).map(([name, rows]) => ({ name, rows })),
    duplicateCustomers: [...customerGroups.entries()].filter(([, rows]) => rows.length > 1).map(([name, rows]) => ({ name, rows })),
    embeddedPhones: customers.filter((customer) => /1\d{10}/.test(customer.name)),
    numericOnlyCustomers: customers.filter((customer) => /^\d+$/.test(customer.name)),
  };
  return { products, customers, issues, counts: { products: products.length, customers: customers.length } };
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Microsoft YaHei" };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6534F" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 24;
}

function styleSheet(sheet, widths) {
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = { from: "A1", to: sheet.getRow(1).getCell(widths.length).address };
  styleHeader(sheet.getRow(1));
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.font = { name: "Microsoft YaHei", size: 10 };
      row.alignment = { vertical: "middle" };
      if (rowNumber % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8EEEE" } };
    }
  });
}

export async function exportMonthlyWorkbook(store, month) {
  const report = store.monthlyReport(month);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "客户订单管理系统";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("客户汇总");
  summary.addRow([`${month}销售与收款汇总`, "", "", "", "", ""]);
  summary.mergeCells("A1:F1");
  summary.getCell("A1").font = { name: "Microsoft YaHei", size: 16, bold: true, color: { argb: "FFC6534F" } };
  summary.getCell("A1").alignment = { horizontal: "center" };
  summary.addRow(["客户", "订单次数", "销售额（元）", "已收款（元）", "欠款（元）", "结账状态"]);
  for (const row of report.customers) summary.addRow([row.customer_name, Number(row.order_count), Number(row.totalAmount), Number(row.paidAmount), Number(row.balance), report.status === "closed" ? "已结账" : "未结账"]);
  summary.addRow(["合计", report.totals.orderCount, Number(report.totals.totalAmount), Number(report.totals.paidAmount), Number(report.totals.balance), ""]);
  styleHeader(summary.getRow(2));
  summary.getColumn(1).width = 30;
  summary.getColumn(2).width = 14;
  summary.getColumn(3).width = 18;
  summary.getColumn(4).width = 14;
  summary.getColumn(5).width = 16;
  summary.getColumn(6).width = 14;
  for (const column of [3, 4, 5]) summary.getColumn(column).numFmt = "#,##0.00";
  summary.views = [{ state: "frozen", ySplit: 2, showGridLines: false }];

  const items = workbook.addWorksheet("商品汇总");
  items.addRow(["客户", "商品", "单位", "数量", "金额（元）"]);
  const customerNames = new Map(report.customers.map((row) => [row.customer_id, row.customer_name]));
  for (const row of report.items) items.addRow([customerNames.get(row.customer_id), row.product_name, row.unit, Number(row.quantity), Number(row.amount)]);
  styleSheet(items, [30, 28, 10, 14, 16]);
  items.getColumn(4).numFmt = "0.###";
  items.getColumn(5).numFmt = "#,##0.00";

  const details = workbook.addWorksheet("订单明细");
  details.addRow(["订单号", "日期", "客户", "商品", "数量", "单位", "单价（元）", "金额（元）", "打印状态"]);
  const { start, next } = (() => {
    const [year, monthNumber] = month.split("-").map(Number);
    return { start: `${month}-01`, next: new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10) };
  })();
  const end = new Date(`${next}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  for (const order of store.listOrders({ dateFrom: start, dateTo: end.toISOString().slice(0, 10) })) {
    const full = store.getOrder(order.id);
    for (const item of full.items) details.addRow([order.order_no, order.order_date, order.customer_name_snapshot, item.product_name_snapshot, Number(item.quantity), item.unit_snapshot, Number(item.unitPrice), Number(item.amount), order.print_status]);
  }
  styleSheet(details, [20, 14, 28, 28, 12, 10, 14, 14, 14]);
  details.getColumn(5).numFmt = "0.###";
  details.getColumn(7).numFmt = "#,##0.00";
  details.getColumn(8).numFmt = "#,##0.00";

  const payments = workbook.addWorksheet("收款记录");
  payments.addRow(["收款日期", "归属月份", "客户", "来源", "订单号", "金额（元）", "备注"]);
  for (const payment of store.listPayments({ month })) payments.addRow([payment.payment_date, payment.applied_month, payment.customer_name, payment.kind === "order" ? "订单全款" : "手工收款", payment.order_no || "", Number(payment.amount), payment.note || ""]);
  styleSheet(payments, [14, 14, 28, 14, 20, 16, 32]);
  payments.getColumn(6).numFmt = "#,##0.00";

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
