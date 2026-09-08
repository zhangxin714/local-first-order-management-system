const params = new URLSearchParams(location.search);
const ids = (params.get("ids") || "").split(",").map(Number).filter(Number.isInteger);
const $ = (selector) => document.querySelector(selector);
let recordingPrinted = false;
let printedRecorded = false;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const formatNumber = (value) => Number(value).toFixed(1);
const formatAmount = (value) => Number(value).toFixed(1);
const formatDateZh = (value) => {
  const [year, month, day] = String(value || "").split("-").map(Number);
  return year && month && day ? `${year}年${month}月${day}日` : String(value || "");
};

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data;
}

function layout(items) {
  const rows = Math.max(5, Math.ceil(items.length / 2));
  const density = items.length <= 10 ? "normal" : items.length <= 14 ? "compact" : items.length <= 20 ? "dense" : "ultra";
  return { rows, density, left: items.slice(0, rows), right: items.slice(rows) };
}

function itemRow(item) {
  if (!item) return `<div class="item-row"><span class="product"></span><span class="item-gap"></span><span class="qty"></span><span class="item-gap"></span><span class="price"></span><span class="item-gap"></span><span class="amount"></span></div>`;
  return `<div class="item-row"><span class="product" title="${esc(item.product_name_snapshot)}">${esc(item.product_name_snapshot)}</span><span class="item-gap"></span><span class="qty"><span class="numeric">${esc(item.quantity)}</span><span class="unit">${esc(item.unit_snapshot)}</span></span><span class="item-gap"></span><span class="price"><span class="operator">×</span><span class="numeric">${formatNumber(item.unitPrice)}</span></span><span class="item-gap"></span><span class="amount"><span class="operator">=</span><span class="numeric">${formatAmount(item.amount)}元</span></span></div>`;
}

function column(items, rows) {
  return `<div class="item-column"><div class="item-header"><span class="product">商品名称</span><span class="item-gap"></span><span class="qty">数量</span><span class="item-gap"></span><span class="price">单价</span><span class="item-gap"></span><span class="amount">金额</span></div>${Array.from({ length: rows }, (_, index) => itemRow(items[index])).join("")}</div>`;
}

function receipt(order, settings, slot) {
  const top = settings[`slot${slot}_position_top_mm`];
  const tableTop = Number(top) + Number(settings.receipt_top_blank_mm);
  const tableBottom = tableTop + Number(settings.receipt_table_height_mm);
  const guide = `<div class="top-blank-guide">顶部留白 ${esc(settings.receipt_top_blank_mm)}mm</div><div class="bottom-blank-guide">底部留白 ${esc(settings.receipt_bottom_blank_mm)}mm</div><div class="table-zone-guide">订单表格 ${esc(settings.receipt_table_height_mm)}mm · ${esc(tableTop)}–${esc(tableBottom)}mm</div><div class="slot-guide"><b>第${slot}联 · ${esc(top)}–${esc(Number(top) + Number(settings.receipt_height_mm))}mm</b><span>${esc(settings.receipt_width_mm)} × ${esc(settings.receipt_height_mm)}mm</span></div>`;
  if (!order) return `<section class="receipt empty" data-slot="${slot}">${guide}<div class="receipt-inner"></div></section>`;
  const plan = layout(order.items);
  return `<section class="receipt ${plan.density}" data-slot="${slot}" style="--item-rows:${plan.rows}">${guide}<div class="receipt-inner">
    <div class="receipt-title">${esc(settings.business_name)}</div>
    <div class="receipt-meta"><span>客户名称：<strong>${esc(order.customer_name_snapshot)}</strong></span><span class="date">日期：<strong>${esc(formatDateZh(order.order_date))}</strong></span></div>
    <div class="receipt-items">${column(plan.left, plan.rows)}${column(plan.right, plan.rows)}</div>
    <div class="receipt-total">合计金额：<strong>${formatAmount(order.totalAmount)} 元</strong></div>
    <div class="receipt-footer"><span class="footer-line">地址：${esc(settings.business_address)}<span class="footer-phone">电话：<span class="footer-phone-number">${esc(settings.business_phone)}</span></span></span></div>
  </div></section>`;
}

async function init() {
  if (!ids.length) throw new Error("没有选择订单");
  const data = await api(`/api/orders/print-data?ids=${ids.join(",")}`);
  const root = document.documentElement;
  const paperWidth = Number(data.settings.paper_width_mm);
  const receiptWidth = Number(data.settings.receipt_width_mm);
  root.style.setProperty("--paper-width", `${paperWidth}mm`);
  root.style.setProperty("--paper-height", `${data.settings.paper_height_mm}mm`);
  root.style.setProperty("--receipt-left", `${(paperWidth - receiptWidth) / 2}mm`);
  root.style.setProperty("--receipt-width", `${receiptWidth}mm`);
  root.style.setProperty("--receipt-height", `${data.settings.receipt_height_mm}mm`);
  root.style.setProperty("--receipt-top-blank", `${data.settings.receipt_top_blank_mm}mm`);
  root.style.setProperty("--receipt-table-height", `${data.settings.receipt_table_height_mm}mm`);
  root.style.setProperty("--receipt-table-bottom", `${Number(data.settings.receipt_top_blank_mm) + Number(data.settings.receipt_table_height_mm)}mm`);
  root.style.setProperty("--receipt-bottom-blank", `${data.settings.receipt_bottom_blank_mm}mm`);
  for (const slot of [1, 2, 3]) root.style.setProperty(`--slot${slot}-top`, `${data.settings[`slot${slot}_position_top_mm`]}mm`);
  root.style.setProperty("--offset-x", `${data.settings.print_offset_x_mm}mm`);
  root.style.setProperty("--offset-y", `${data.settings.print_offset_y_mm}mm`);
  root.style.setProperty("--content-padding-x", `${data.settings.content_padding_x_mm}mm`);
  root.style.setProperty("--column-gap", `${data.settings.column_gap_mm}mm`);
  root.style.setProperty("--item-product-width", `${data.settings.item_product_width_mm}mm`);
  root.style.setProperty("--item-quantity-width", `${data.settings.item_quantity_width_mm}mm`);
  root.style.setProperty("--item-unit-price-width", `${data.settings.item_unit_price_width_mm}mm`);
  root.style.setProperty("--item-amount-width", `${data.settings.item_amount_width_mm}mm`);
  root.style.setProperty("--item-gap-product-quantity", `${data.settings.item_gap_product_quantity_mm}mm`);
  root.style.setProperty("--item-gap-quantity-price", `${data.settings.item_gap_quantity_price_mm}mm`);
  root.style.setProperty("--item-gap-price-amount", `${data.settings.item_gap_price_amount_mm}mm`);
  root.style.setProperty("--character-spacing", `${data.settings.character_spacing_mm}mm`);
  const baseFont = Number(data.settings.base_font_size_mm);
  for (const [name, ratio] of Object.entries({ "--title-font": 1.59, "--meta-font": .955, "--meta-strong-font": 1.045, "--header-font": .845, "--item-font-base": 1, "--item-font-compact": .9, "--item-font-dense": .77, "--item-font-ultra": .64, "--total-font": 1.045, "--total-strong-font": 1.27 })) root.style.setProperty(name, `${baseFont * ratio}mm`);
  const rowHeight = Number(data.settings.line_height_mm);
  for (const [name, ratio] of Object.entries({ "--row-height-base": 1, "--row-height-compact": .9, "--row-height-dense": .77, "--row-height-ultra": .64 })) root.style.setProperty(name, `${rowHeight * ratio}mm`);
  document.head.insertAdjacentHTML("beforeend", `<style>@page { size: ${paperWidth}mm ${Number(data.settings.paper_height_mm)}mm; margin: 0; }</style>`);
  const pages = [];
  for (let i = 0; i < data.orders.length; i += 3) pages.push(data.orders.slice(i, i + 3));
  $("#print-root").innerHTML = pages.map((page) => `<article class="print-page"><div class="page-content">${[0,1,2].map((slot) => receipt(page[slot], data.settings, slot + 1)).join("")}</div></article>`).join("");
  $("#print-summary").textContent = `${data.orders.length}个客户，${pages.length}页，${data.settings.paper_width_mm}×${data.settings.paper_height_mm}mm · 每联 ${data.settings.receipt_top_blank_mm}+${data.settings.receipt_table_height_mm}+${data.settings.receipt_bottom_blank_mm}=${data.settings.receipt_height_mm}mm`;
}

async function recordPrinted() {
  if (recordingPrinted || printedRecorded) return false;
  if (!confirm("打印窗口已关闭。\n\n如果打印机已经正常出纸，请点“确定”，这些订单会立即显示为“已打印”。\n如果取消了打印或打印失败，请点“取消”，订单继续保持“待打印”。")) return false;
  recordingPrinted = true;
  const button = $("#mark-printed");
  button.disabled = true;
  button.textContent = "正在记录…";
  try {
    const batch = await api("/api/print/record", { method: "POST", body: { orderIds: ids, status: "printed" } });
    printedRecorded = true;
    button.textContent = "已标记为已打印";
    const message = { type: "orders-printed", orderIds: ids, batchNo: batch.batchNo, changedAt: Date.now() };
    try { window.opener?.postMessage(message, location.origin); } catch {}
    try { localStorage.setItem("order-print-status-changed", JSON.stringify(message)); } catch {}
    alert(`已标记为“已打印”\n打印批次：${batch.batchNo}`);
    window.close();
    return true;
  } catch (error) {
    button.disabled = false;
    button.textContent = "确认打印完成";
    alert(error.message);
    return false;
  } finally {
    recordingPrinted = false;
  }
}

$("#do-print").addEventListener("click", () => window.print());
$("#close-window").addEventListener("click", () => window.close());
$("#mark-printed").addEventListener("click", recordPrinted);
window.addEventListener("afterprint", () => { setTimeout(recordPrinted, 0); });

init().catch((error) => { $("#print-root").innerHTML = `<div style="padding:30px;color:#a33">${esc(error.message)}</div>`; });
