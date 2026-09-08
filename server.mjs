import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "./src/db.mjs";
import { BusinessError, normalizeDate, normalizeMonth } from "./src/domain.mjs";
import { previewCatalogWorkbook, exportMonthlyWorkbook } from "./src/excel.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DATA_DIR = process.env.ORDER_DATA_DIR ? path.resolve(process.env.ORDER_DATA_DIR) : path.join(APP_DIR, "data");
const BACKUP_DIR = process.env.ORDER_BACKUP_DIR ? path.resolve(process.env.ORDER_BACKUP_DIR) : path.join(APP_DIR, "backups");
const PORT = Number(process.env.PORT || 37831);
const HOST = process.env.HOST || "0.0.0.0";
const store = new Store(path.join(DATA_DIR, "orders.sqlite"));
const importSessions = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const content = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": content.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(content);
}

function sendError(res, error) {
  if (error instanceof BusinessError) {
    sendJson(res, error.status, { error: error.message, code: error.code, details: error.details });
    return;
  }
  if (String(error?.message || "").includes("UNIQUE constraint failed")) {
    sendJson(res, 409, { error: "编号已存在，请更换后重试", code: "DUPLICATE" });
    return;
  }
  console.error(error);
  sendJson(res, 500, { error: "系统内部错误，请稍后重试", code: "INTERNAL_ERROR" });
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BusinessError("上传内容过大", "PAYLOAD_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw new BusinessError("请求数据不是有效JSON", "INVALID_JSON"); }
}

function matchPath(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1) : null;
}

function mobileAccessUrls() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const address = entry.address;
      const privateNetwork = /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
      if (privateNetwork) addresses.push(address);
    }
  }
  return [...new Set(addresses)].map((address) => `http://${address}:${PORT}`);
}

async function api(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  if (pathname === "/api/health" && method === "GET") return sendJson(res, 200, { ok: true, version: "2.4.11" });
  if (pathname === "/api/network-info" && method === "GET") return sendJson(res, 200, { port: PORT, host: HOST, localUrl: `http://127.0.0.1:${PORT}`, mobileUrls: mobileAccessUrls() });
  if (pathname === "/api/settings" && method === "GET") return sendJson(res, 200, store.getSettings());
  if (pathname === "/api/settings" && method === "PUT") return sendJson(res, 200, store.updateSettings(await readJson(req)));

  if (pathname === "/api/dashboard" && method === "GET") {
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    return sendJson(res, 200, store.dashboard(date));
  }

  if (pathname === "/api/products" && method === "GET") {
    return sendJson(res, 200, store.listProducts({ search: url.searchParams.get("search") || "", includeInactive: url.searchParams.get("all") === "1" }));
  }
  if (pathname === "/api/products" && method === "POST") return sendJson(res, 201, store.createProduct(await readJson(req)));
  const productMatch = matchPath(pathname, /^\/api\/products\/(\d+)$/);
  if (productMatch && method === "PUT") return sendJson(res, 200, store.updateProduct(Number(productMatch[0]), await readJson(req)));
  if (productMatch && method === "DELETE") return sendJson(res, 200, store.deleteProduct(Number(productMatch[0])));
  const productUnitsMatch = matchPath(pathname, /^\/api\/products\/(\d+)\/units$/);
  if (productUnitsMatch && method === "GET") return sendJson(res, 200, store.getProductUnits(Number(productUnitsMatch[0]), { includeInactive: true }));
  if (productUnitsMatch && method === "PUT") return sendJson(res, 200, store.updateProductUnits(Number(productUnitsMatch[0]), await readJson(req)));

  if (pathname === "/api/customers" && method === "GET") {
    return sendJson(res, 200, store.listCustomers({ search: url.searchParams.get("search") || "", includeInactive: url.searchParams.get("all") === "1" }));
  }
  if (pathname === "/api/customers" && method === "POST") return sendJson(res, 201, store.createCustomer(await readJson(req)));
  const customerMatch = matchPath(pathname, /^\/api\/customers\/(\d+)$/);
  if (customerMatch && method === "PUT") return sendJson(res, 200, store.updateCustomer(Number(customerMatch[0]), await readJson(req)));
  if (customerMatch && method === "DELETE") return sendJson(res, 200, store.deleteCustomer(Number(customerMatch[0])));
  const customerPricesMatch = matchPath(pathname, /^\/api\/customers\/(\d+)\/prices$/);
  if (customerPricesMatch && method === "GET") return sendJson(res, 200, store.getCustomerPrices(Number(customerPricesMatch[0])));
  if (customerPricesMatch && method === "PUT") return sendJson(res, 200, store.updateCustomerPrices(Number(customerPricesMatch[0]), await readJson(req)));

  if (pathname === "/api/orders" && method === "GET") {
    return sendJson(res, 200, store.listOrders(Object.fromEntries(url.searchParams.entries())));
  }
  if (pathname === "/api/orders" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 201, store.createOrder(body, { sourceOrderId: body.sourceOrderId || null }));
  }
  if (pathname === "/api/mobile/sync-orders" && method === "POST") {
    const body = await readJson(req);
    if (!Array.isArray(body.orders) || !body.orders.length) throw new BusinessError("没有可同步的离线订单", "VALIDATION_ERROR");
    if (body.orders.length > 100) throw new BusinessError("一次最多同步100张订单", "VALIDATION_ERROR");
    const results = body.orders.map((entry) => {
      const clientRequestId = String(entry?.clientRequestId || "").trim();
      if (!clientRequestId) throw new BusinessError("离线订单缺少同步标识", "VALIDATION_ERROR");
      const order = store.createOrder(entry.order || {}, { sourceOrderId: entry.order?.sourceOrderId || null, mobileClientId: clientRequestId });
      return { clientRequestId, orderId: order.id, orderNo: order.order_no };
    });
    return sendJson(res, 201, { results });
  }
  if (pathname === "/api/orders/print-data" && method === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").map(Number).filter(Number.isInteger);
    return sendJson(res, 200, { settings: store.getSettings(), orders: ids.map((id) => store.getOrder(id)) });
  }
  const orderMatch = matchPath(pathname, /^\/api\/orders\/(\d+)$/);
  if (orderMatch && method === "GET") return sendJson(res, 200, store.getOrder(Number(orderMatch[0])));
  if (orderMatch && method === "PUT") return sendJson(res, 200, store.updateOrder(Number(orderMatch[0]), await readJson(req)));
  if (orderMatch && method === "DELETE") return sendJson(res, 200, store.deleteOrder(Number(orderMatch[0]), (await readJson(req)).reason));
  const orderPaymentMatch = matchPath(pathname, /^\/api\/orders\/(\d+)\/payment-status$/);
  if (orderPaymentMatch && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, store.setOrderPaymentStatus(Number(orderPaymentMatch[0]), body.paid, body.paymentDate));
  }
  const copyMatch = matchPath(pathname, /^\/api\/customers\/(\d+)\/copy-yesterday$/);
  if (copyMatch && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, store.copyYesterday(Number(copyMatch[0]), body.today));
  }
  const copyPreviousMatch = matchPath(pathname, /^\/api\/customers\/(\d+)\/copy-previous-order$/);
  if (copyPreviousMatch && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, store.copyPreviousOrder(Number(copyPreviousMatch[0]), body.today));
  }
  const voidMatch = matchPath(pathname, /^\/api\/orders\/(\d+)\/void$/);
  if (voidMatch && method === "POST") return sendJson(res, 200, store.deleteOrder(Number(voidMatch[0]), (await readJson(req)).reason));

  if (pathname === "/api/reports/monthly" && method === "GET") {
    return sendJson(res, 200, store.monthlyReport(url.searchParams.get("month"), url.searchParams.get("customerId")));
  }
  if (pathname === "/api/reports/monthly/close" && method === "POST") return sendJson(res, 200, store.closeMonth((await readJson(req)).month));
  if (pathname === "/api/reports/monthly/reopen" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, store.reopenMonth(body.month, body.reason));
  }
  if (pathname === "/api/reports/monthly/export" && method === "GET") {
    const month = normalizeMonth(url.searchParams.get("month"));
    const buffer = await exportMonthlyWorkbook(store, month);
    const filename = `${month}客户销售汇总.xlsx`;
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    return res.end(buffer);
  }

  if (pathname === "/api/payments" && method === "GET") return sendJson(res, 200, store.listPayments(Object.fromEntries(url.searchParams.entries())));
  if (pathname === "/api/payments" && method === "POST") return sendJson(res, 201, store.createPayment(await readJson(req)));
  const paymentVoidMatch = matchPath(pathname, /^\/api\/payments\/(\d+)\/void$/);
  if (paymentVoidMatch && method === "POST") return sendJson(res, 200, store.voidPayment(Number(paymentVoidMatch[0]), (await readJson(req)).reason));
  if (pathname === "/api/ledger" && method === "GET") return sendJson(res, 200, store.customerLedger(url.searchParams.get("month"), url.searchParams.get("customerId")));

  if (pathname === "/api/print/record" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 201, store.recordPrint(body.orderIds, body.status || "printed", body.errorMessage || null));
  }

  if (pathname === "/api/import/excel/preview" && method === "POST") {
    const buffer = await readBody(req, 30 * 1024 * 1024);
    const preview = await previewCatalogWorkbook(buffer);
    const token = crypto.randomUUID();
    importSessions.set(token, { preview, expires: Date.now() + 30 * 60 * 1000 });
    return sendJson(res, 200, { token, counts: preview.counts, issues: preview.issues });
  }
  if (pathname === "/api/import/excel/commit" && method === "POST") {
    const body = await readJson(req);
    const session = importSessions.get(body.token);
    if (!session || session.expires < Date.now()) throw new BusinessError("导入预览已过期，请重新选择Excel", "IMPORT_SESSION_EXPIRED", 410);
    const result = store.bulkImportCatalog(session.preview, { allowDuplicates: Boolean(body.allowDuplicates) });
    importSessions.delete(body.token);
    return sendJson(res, 200, result);
  }

  if (pathname === "/api/backup" && method === "POST") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = path.join(BACKUP_DIR, `orders-${stamp}.sqlite`);
    await store.backupTo(output);
    return sendJson(res, 201, { filename: path.basename(output) });
  }

  throw new BusinessError("接口不存在", "NOT_FOUND", 404);
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) throw new BusinessError("文件不存在", "NOT_FOUND", 404);
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Content-Length": content.length, "Cache-Control": "no-store" });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") throw new BusinessError("页面不存在", "NOT_FOUND", 404);
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (error) {
    sendError(res, error);
  }
});

async function dailyBackup() {
  try {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const output = path.join(BACKUP_DIR, `orders-${date}.sqlite`);
    try { await fs.access(output); }
    catch { await store.backupTo(output); }
  } catch (error) {
    console.error("自动备份失败：", error.message);
  }
}

function scheduleNightlyBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(22, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const timer = setTimeout(async () => {
    await dailyBackup();
    scheduleNightlyBackup();
  }, next.getTime() - now.getTime());
  timer.unref?.();
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1") return;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

server.listen(PORT, HOST, async () => {
  await dailyBackup();
  scheduleNightlyBackup();
  const localUrl = `http://127.0.0.1:${PORT}`;
  console.log(`客户订单管理系统已启动：${localUrl}`);
  for (const url of mobileAccessUrls()) console.log(`手机访问地址：${url}`);
  openBrowser(localUrl);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
