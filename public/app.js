const state = {
  products: [],
  customers: [],
  todayOrders: [],
  selectedPrint: new Set(),
  importToken: null,
  edit: null,
  editingOrder: null,
  copiedOrderDraft: null,
  monthReport: null,
  customerPrices: new Map(),
  customerPriceRows: [],
  installPrompt: null,
};
let draggingOrderItem = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const localDate = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const currentMonth = () => localDate().slice(0, 7);
const OFFLINE_CACHE_PREFIX = "laoda-order-offline-cache:";
const OFFLINE_QUEUE_KEY = "laoda-order-offline-queue";
const MOBILE_SERVER_KEY = "laoda-order-mobile-server";
// Capacitor 在 Android 上通常显示为 http://localhost，而不是 capacitor:。
// 只检查协议会把安卓安装包误当成普通网页，因而不会要求填写电脑地址。
const nativeMobileApp = Boolean(globalThis.Capacitor?.isNativePlatform?.())
  || ["capacitor:", "ionic:"].includes(location.protocol)
  || (location.protocol === "http:" && location.hostname === "localhost" && /Android/i.test(navigator.userAgent));
function apiBaseUrl() { return nativeMobileApp ? String(localStorage.getItem(MOBILE_SERVER_KEY) || "").replace(/\/$/, "") : ""; }
function apiUrl(url) { return `${apiBaseUrl()}${url}`; }

function canCacheOffline(url) {
  return url.startsWith("/api/products") || url.startsWith("/api/customers") || url === "/api/settings";
}
function readOfflineJson(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key) || "") ?? fallback; } catch { return fallback; }
}
function writeOfflineJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 手机上空间不足时仍可正常在线使用 */ }
}
function queuedOfflineOrders() { return readOfflineJson(OFFLINE_QUEUE_KEY, []); }
function refreshOfflineSyncStatus() {
  const target = $("#offline-sync-status");
  if (!target) return;
  const count = queuedOfflineOrders().length;
  target.textContent = count ? `手机离线待同步：${count} 张订单。连接店内Wi-Fi后会自动传到电脑。` : "手机离线队列：暂无待同步订单。";
  target.className = count ? "notice offline-pending" : "notice";
}
function isNetworkError(error) { return !navigator.onLine || error instanceof TypeError || /网络|network|failed to fetch/i.test(String(error?.message || "")); }
function makeOfflineId() { return globalThis.crypto?.randomUUID?.() || `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function queueOfflineOrder(order) {
  const entries = queuedOfflineOrders();
  entries.push({ clientRequestId: makeOfflineId(), order, queuedAt: new Date().toISOString() });
  writeOfflineJson(OFFLINE_QUEUE_KEY, entries);
  refreshOfflineSyncStatus();
}
async function syncOfflineOrders() {
  const entries = queuedOfflineOrders();
  if (!entries.length || !navigator.onLine) return;
  try {
    const response = await fetch(apiUrl("/api/mobile/sync-orders"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orders: entries }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "离线订单同步失败");
    writeOfflineJson(OFFLINE_QUEUE_KEY, []);
    refreshOfflineSyncStatus();
    toast(`已同步 ${result.results.length} 张手机离线订单`);
    if ($("#view-dashboard").classList.contains("active")) await loadDashboard();
  } catch (error) {
    refreshOfflineSyncStatus();
  }
}

async function api(url, options = {}) {
  const config = { ...options, headers: { ...(options.headers || {}) } };
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer)) {
    config.headers["Content-Type"] = "application/json";
    config.body = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(apiUrl(url), config);
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.blob();
    if (!response.ok) throw new Error(data.error || "操作失败");
    if ((!options.method || options.method === "GET") && canCacheOffline(url) && !(data instanceof Blob)) writeOfflineJson(`${OFFLINE_CACHE_PREFIX}${url}`, data);
    return data;
  } catch (error) {
    if ((!options.method || options.method === "GET") && canCacheOffline(url)) {
      const cached = readOfflineJson(`${OFFLINE_CACHE_PREFIX}${url}`);
      if (cached) return cached;
    }
    throw error;
  }
}

let toastTimer;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3000);
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close("cancel");
}

function setupMobileAppInstall() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
  });
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

async function installMobileApp() {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    return;
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  alert(ios
    ? "苹果手机：请用 Safari 打开系统，点击底部“分享”按钮，然后选择“添加到主屏幕”。"
    : "安卓手机：请在浏览器右上角点击“⋮”，选择“添加到主屏幕”或“安装应用”。");
}

const titles = {
  dashboard: ["今日订单", "快速录单、汇总和连续打印"],
  "new-order": ["新增订单", "选择客户和商品，金额由系统计算"],
  "print-center": ["打印中心", "Epson LQ-630KII 三客户连续打印"],
  products: ["商品管理", "一个商品可配置袋、件等多个销售单位"],
  customers: ["客户管理", "维护客户资料和打印顺序"],
  "customer-prices": ["客户价格管理", "为不同客户设置不同商品价格"],
  ledger: ["客户账本", "登记收款并查看欠款"],
  history: ["历史订单", "永久保存、随时查询"],
  monthly: ["月度汇总", "月底核对并确认结账"],
  data: ["数据导入导出", "迁移旧Excel和备份数据库"],
  "mobile-access": ["手机访问", "同一Wi-Fi下使用手机录单和查询"],
  settings: ["打印设置", "固定毫米坐标与Epson实机校准"],
};

async function showView(name) {
  $$(".view").forEach((view) => view.classList.remove("active"));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $(`#view-${name}`).classList.add("active");
  $("#page-title").textContent = titles[name][0];
  $("#page-subtitle").textContent = titles[name][1];
  try {
    if (name === "dashboard") await loadDashboard();
    if (name === "new-order") {
      prepareOrderForm();
      const selectedCustomerId = Number($("#order-customer").value || 0);
      if (selectedCustomerId) await chooseCustomer(selectedCustomerId);
    }
    if (name === "print-center") await loadPrintCenter();
    if (name === "products") await loadProducts();
    if (name === "customers") await loadCustomers();
    if (name === "customer-prices") await loadCustomerPricePage();
    if (name === "ledger") await loadLedger();
    if (name === "history") await loadHistory();
    if (name === "monthly") await loadMonthly();
    if (name === "mobile-access") await loadMobileAccess();
    if (name === "settings") await loadSettings();
  } catch (error) { toast(error.message, true); }
}

function printStatusTag(status) {
  const map = { unprinted: ["待打印", "red"], queued: ["打印中", ""], printed: ["已打印", "green"], failed: ["失败待重试", "red"] };
  const [text, cls] = map[status] || [status, ""];
  return `<span class="tag ${cls}">${text}</span>`;
}

function orderTable(orders, { selectable = false, actions = true, editable = false, deletable = false } = {}) {
  if (!orders.length) return `<div class="empty">暂无订单</div>`;
  const showActions = actions || editable;
  return `<table><thead><tr>${selectable ? "<th>选择</th>" : ""}<th>订单号</th><th>日期</th><th>客户</th><th>商品项数</th><th class="money">金额</th><th>付款</th><th>打印</th>${showActions ? "<th>操作</th>" : ""}</tr></thead><tbody>${orders.map((order) => `<tr>
    ${selectable ? `<td><input class="print-check" type="checkbox" value="${order.id}" ${state.selectedPrint.has(order.id) ? "checked" : ""}></td>` : ""}
    <td>${esc(order.order_no)}</td><td>${esc(order.order_date)}</td><td>${esc(order.customer_name_snapshot)}</td><td>${order.itemCount}</td><td class="money">${money(order.totalAmount)}</td><td><span class="tag ${order.payment_status === "paid" ? "green" : "red"}">${order.payment_status === "paid" ? "已付款" : "未付款"}</span></td><td>${printStatusTag(order.print_status)}</td>
    ${showActions ? `<td>${actions ? `<button class="link-btn view-order" data-id="${order.id}">查看</button><button class="link-btn toggle-order-paid" data-id="${order.id}" data-paid="${order.payment_status !== "paid"}">${order.payment_status === "paid" ? "撤销付款" : "标记已付款"}</button>` : ""}${editable && order.status === "saved" && ["unprinted", "failed"].includes(order.print_status) ? `<button class="link-btn mark-order-printed" data-id="${order.id}" data-order-no="${esc(order.order_no)}">标记已打印</button><button class="link-btn edit-pending-order" data-id="${order.id}">修改</button>` : ""}${(deletable && order.status === "saved" && ["unprinted", "failed"].includes(order.print_status)) || (actions && order.status === "saved") ? `<button class="link-btn danger-link delete-order" data-id="${order.id}" data-order-no="${esc(order.order_no)}">删除</button>` : ""}</td>` : ""}
  </tr>`).join("")}</tbody></table>`;
}

async function loadCatalogs() {
  [state.products, state.customers] = await Promise.all([api("/api/products?all=1"), api("/api/customers?all=1")]);
  fillCatalogSelects();
}

function fillCatalogSelects() {
  const activeCustomers = state.customers.filter((item) => item.status === "active");
  const ledgerCustomerId = Number($("#ledger-customer").value || activeCustomers[0]?.id || 0);
  if (ledgerCustomerId) setFilterCustomerPicker("ledger-customer-input", ledgerCustomerId);
  for (const [inputId, hiddenId] of Object.entries(filterCustomerPickerTargets)) {
    if (inputId === "ledger-customer-input") continue;
    const selectedId = Number($(`#${hiddenId}`).value || 0);
    if (selectedId && !activeCustomers.some((customer) => customer.id === selectedId)) setFilterCustomerPicker(inputId, "");
  }
  const selectedProductId = Number($("#history-product").value || 0);
  if (selectedProductId && !state.products.some((product) => product.id === selectedProductId && product.status === "active")) chooseHistoryProduct("");
}

async function loadDashboard() {
  const date = $("#work-date").value;
  const [dashboard, orders] = await Promise.all([api(`/api/dashboard?date=${date}`), api(`/api/orders?date=${date}`)]);
  state.todayOrders = orders;
  $("#kpi-orders").textContent = dashboard.orderCount;
  $("#kpi-pending").textContent = dashboard.pendingPrint;
  $("#kpi-total").textContent = money(dashboard.totalAmount);
  $("#today-orders").innerHTML = orderTable(orders);
}

function activeUnits(product) {
  return (product?.units || []).filter((unit) => unit.status === "active");
}

function baseUnit(product) {
  return activeUnits(product).find((unit) => unit.is_base) || activeUnits(product)[0];
}

function priceForUnit(unit) {
  return unit ? state.customerPrices.get(unit.id) ?? unit.price : 0;
}

function productLabel(product) {
  const unit = baseUnit(product);
  const custom = unit && state.customerPrices.has(unit.id);
  return product ? `${product.name} · ${unit?.unit_name || product.unit} · ${money(priceForUnit(unit))}${custom ? " 客户价" : ""}` : "";
}

function customerLabel(customer) {
  return customer ? customer.name : "";
}

const filterCustomerPickerTargets = {
  "history-customer-input": "history-customer",
  "report-customer-input": "report-customer",
  "ledger-customer-input": "ledger-customer",
};

function setFilterCustomerPicker(inputId, customerId) {
  const customer = state.customers.find((item) => item.id === Number(customerId) && item.status === "active");
  const hiddenId = filterCustomerPickerTargets[inputId];
  if (!hiddenId) return;
  $(`#${hiddenId}`).value = customer?.id || "";
  $(`#${inputId}`).value = customerLabel(customer);
  $(`#${inputId}`).closest(".customer-picker").querySelector(".customer-suggestions").classList.remove("show");
}

async function chooseFilterCustomer(inputId, customerId) {
  setFilterCustomerPicker(inputId, customerId);
  if (inputId === "ledger-customer-input") await loadLedger();
}

function applyCustomerPrices(result) {
  state.customerPrices = new Map((result?.prices || []).filter((row) => row.customerPrice != null).map((row) => [Number(row.product_unit_id), row.customerPrice]));
}

function refreshUnsavedOrderPrices() {
  $$(".item-row").forEach((row) => {
    if (row.dataset.savedPrice) return;
    const product = state.products.find((item) => item.id === Number(row.querySelector(".item-product").value));
    if (product) row.querySelector(".item-product-input").value = productLabel(product);
    updateItemRow(row);
  });
}

function renderCustomerSuggestions(input, showAll = false) {
  const keyword = showAll ? "" : input.value.trim().toLowerCase();
  const suggestions = input.closest(".customer-picker").querySelector(".customer-suggestions");
  const matches = state.customers.filter((customer) => customer.status === "active" && (!keyword || customer.name.toLowerCase().includes(keyword) || String(customer.contact || "").toLowerCase().includes(keyword) || String(customer.phone || "").toLowerCase().includes(keyword) || String(customer.address || "").toLowerCase().includes(keyword)));
  suggestions.innerHTML = matches.length ? matches.map((customer, index) => `<button type="button" class="customer-suggestion${index === 0 ? " active" : ""}" data-id="${customer.id}" data-picker="${esc(input.id)}"><b>${esc(customer.name)}</b><span>${customer.phone ? esc(customer.phone) : esc(customer.contact || "")}</span></button>`).join("") : `<div class="suggestion-empty">没有匹配客户</div>`;
  suggestions.classList.add("show");
}

function renderFilterProductSuggestions(input, showAll = false) {
  const keyword = showAll ? "" : input.value.trim().toLowerCase();
  const suggestions = input.closest(".product-picker").querySelector(".product-suggestions");
  const matches = state.products.filter((product) => product.status === "active" && (!keyword || product.name.toLowerCase().includes(keyword) || product.unit.toLowerCase().includes(keyword) || activeUnits(product).some((unit) => unit.unit_name.toLowerCase().includes(keyword))));
  suggestions.innerHTML = matches.length ? matches.map((product, index) => `<button type="button" class="filter-product-suggestion${index === 0 ? " active" : ""}" data-id="${product.id}"><b>${esc(product.name)}</b><span>${activeUnits(product).map((unit) => esc(unit.unit_name)).join("/")}</span></button>`).join("") : `<div class="suggestion-empty">没有匹配商品</div>`;
  suggestions.classList.add("show");
}

function chooseHistoryProduct(productId) {
  const product = state.products.find((item) => item.id === Number(productId) && item.status === "active");
  $("#history-product").value = product?.id || "";
  $("#history-product-input").value = product ? `${product.name} / ${product.unit}` : "";
  $("#history-product-input").closest(".product-picker").querySelector(".product-suggestions").classList.remove("show");
}

async function chooseCustomer(customerId) {
  const customer = state.customers.find((item) => item.id === Number(customerId));
  const previousCustomerId = Number($("#order-customer").value || 0);
  $("#order-customer").value = customer?.id || "";
  $("#order-customer-input").value = customerLabel(customer);
  $("#order-customer-input").closest(".customer-picker").querySelector(".customer-suggestions").classList.remove("show");
  state.customerPrices = new Map();
  if (customer) {
    const result = await api(`/api/customers/${customer.id}/prices`);
    applyCustomerPrices(result);
  }
  if (previousCustomerId && previousCustomerId !== Number(customer?.id)) $$(".item-row").forEach((row) => { row.dataset.savedPrice = ""; });
  refreshUnsavedOrderPrices();
}

async function choosePriceCustomer(customerId) {
  const customer = state.customers.find((item) => item.id === Number(customerId) && item.status === "active");
  $("#price-customer").value = customer?.id || "";
  $("#price-customer-input").value = customerLabel(customer);
  $("#price-customer-input").closest(".customer-picker").querySelector(".customer-suggestions").classList.remove("show");
  await loadCustomerPricePage();
}

function chooseCopyCustomer(customerId) {
  const customer = state.customers.find((item) => item.id === Number(customerId) && item.status === "active");
  $("#copy-customer").value = customer?.id || "";
  $("#copy-customer-input").value = customerLabel(customer);
  $("#copy-customer-input").closest(".customer-picker").querySelector(".customer-suggestions").classList.remove("show");
}

function renderProductSuggestions(input, showAll = false) {
  const row = input.closest(".item-row");
  const keyword = showAll ? "" : input.value.trim().toLowerCase();
  const suggestions = row.querySelector(".product-suggestions");
  const matches = state.products.filter((product) => product.status === "active" && (!keyword || product.name.toLowerCase().includes(keyword) || product.unit.toLowerCase().includes(keyword) || activeUnits(product).some((unit) => unit.unit_name.toLowerCase().includes(keyword))));
  suggestions.innerHTML = matches.length ? matches.map((product, index) => { const unit = baseUnit(product); return `<button type="button" class="product-suggestion${index === 0 ? " active" : ""}" data-id="${product.id}"><b>${esc(product.name)}</b><span>${activeUnits(product).map((item) => esc(item.unit_name)).join("/")} · ${money(priceForUnit(unit))}${state.customerPrices.has(unit?.id) ? " · 客户价" : ""}</span></button>`; }).join("") : `<div class="suggestion-empty">没有匹配商品</div>`;
  suggestions.classList.add("show");
}

function chooseProduct(row, productId) {
  const product = state.products.find((item) => item.id === Number(productId));
  row.dataset.savedPrice = "";
  row.querySelector(".item-product").value = product?.id || "";
  row.querySelector(".item-product-input").value = productLabel(product);
  row.querySelector(".product-suggestions").classList.remove("show");
  fillRowUnits(row, baseUnit(product)?.id);
  updateItemRow(row);
}

function fillRowUnits(row, selectedId = null) {
  const product = state.products.find((item) => item.id === Number(row.querySelector(".item-product").value));
  const select = row.querySelector(".item-unit");
  const units = activeUnits(product);
  const wanted = Number(selectedId || select.value || baseUnit(product)?.id);
  select.innerHTML = units.map((unit) => `<option value="${unit.id}" ${unit.id === wanted ? "selected" : ""}>${esc(unit.unit_name)}</option>`).join("");
}

function addOrderItem(item = {}, options = {}) {
  const selectedProduct = state.products.find((product) => product.id === Number(item.productId));
  const selectedUnit = selectedProduct?.units?.find((unit) => unit.id === Number(item.productUnitId) || (!item.productUnitId && unit.unit_name === item.unitSnapshot)) || baseUnit(selectedProduct);
  const row = document.createElement("div");
  row.className = "order-row item-row";
  row.dataset.savedPrice = item.unitPrice || "";
  row.innerHTML = `<div class="product-entry"><button type="button" class="drag-item" draggable="true" title="按住并拖到任意商品行的前后位置" aria-label="拖动商品排序">⋮⋮</button><div class="product-picker"><input class="item-product-input" autocomplete="off" value="${esc(productLabel(selectedProduct))}" placeholder="输入一个字搜索商品"><input class="item-product" type="hidden" value="${esc(item.productId || "")}"><div class="product-suggestions"></div></div></div><input class="item-quantity" type="number" min="0.001" step="any" inputmode="decimal" value="${esc(item.quantity || "")}" placeholder="数量，如4.6" title="可以输入整数或最多三位小数；键盘上下键每次增减0.5"><select class="item-unit" aria-label="销售单位"></select><span class="readonly item-price">—</span><span class="readonly item-amount">¥0.00</span><div class="item-row-actions"><button type="button" class="move-item-top" title="把这项商品直接放到第一行">置顶</button><button type="button" class="insert-item-before" title="在本行商品前插入一行空白商品">前插</button><button type="button" class="insert-item-after" title="在本行商品后插入一行空白商品">后插</button><button type="button" class="remove-item" title="删除商品" aria-label="删除商品">×</button></div>`;
  const container = $("#order-items");
  if (options.before) container.insertBefore(row, options.before);
  else container.append(row);
  fillRowUnits(row, selectedUnit?.id);
  updateItemRow(row);
  if (options.focus) requestAnimationFrame(() => row.querySelector(".item-product-input")?.focus());
  return row;
}

function moveOrderItemToTop(row) {
  const container = $("#order-items");
  if (row !== container.firstElementChild) container.insertBefore(row, container.firstElementChild);
  // 保存订单时按当前页面从上到下的顺序写入，打印也保持同样顺序。
  row.querySelector(".item-product-input")?.focus({ preventScroll: true });
}

function insertBlankOrderItem(row, placement) {
  const before = placement === "before" ? row : row.nextElementSibling;
  addOrderItem({}, { before, focus: true });
}

function clearOrderDragMarks() {
  $$(".item-row.dragging, .item-row.drop-before, .item-row.drop-after").forEach((row) => row.classList.remove("dragging", "drop-before", "drop-after"));
}

function finishOrderItemDrag() {
  clearOrderDragMarks();
  draggingOrderItem = null;
}

function updateItemRow(row) {
  const product = state.products.find((item) => item.id === Number(row.querySelector(".item-product").value));
  const unit = product?.units?.find((item) => item.id === Number(row.querySelector(".item-unit").value));
  const quantity = Number(row.querySelector(".item-quantity").value || 0);
  const unitPrice = row.dataset.savedPrice || priceForUnit(unit);
  row.querySelector(".item-price").textContent = unit ? money(unitPrice) : "—";
  row.querySelector(".item-amount").textContent = unit ? money(quantity * Number(unitPrice)) : "¥0.00";
  updateOrderTotal();
}

function updateOrderTotal() {
  const rows = $$(".item-row");
  const total = rows.reduce((sum, row) => {
    const product = state.products.find((item) => item.id === Number(row.querySelector(".item-product").value));
    const unit = product?.units?.find((item) => item.id === Number(row.querySelector(".item-unit").value));
    const unitPrice = row.dataset.savedPrice || priceForUnit(unit);
    return sum + (unit ? Number(unitPrice) * Number(row.querySelector(".item-quantity").value || 0) : 0);
  }, 0);
  $("#order-item-count").textContent = rows.filter((row) => Number(row.querySelector(".item-product").value)).length;
  $("#order-total").textContent = money(total);
}

function prepareOrderForm(reset = false) {
  $("#order-date").value ||= $("#work-date").value;
  if (reset || !$("#order-items").children.length) {
    $("#order-items").innerHTML = "";
    $("#order-customer").value = "";
    $("#order-customer-input").value = "";
    state.customerPrices = new Map();
    $("#order-note").value = "";
    addOrderItem();
    addOrderItem();
  }
  updateOrderTotal();
}

function setOrderEditUi(order = null, copiedDraft = null) {
  state.editingOrder = order ? { id: order.id, version: order.version, orderNo: order.order_no } : null;
  state.copiedOrderDraft = copiedDraft || null;
  const banner = $("#order-edit-banner");
  banner.hidden = !order && !copiedDraft;
  banner.querySelector("b").textContent = copiedDraft ? "正在修改复制的今日订单" : "正在修改待打印订单";
  $("#editing-order-no").textContent = order ? order.order_no : copiedDraft ? `复制自 ${copiedDraft.sourceDate} · ${copiedDraft.sourceOrderNo}（尚未保存）` : "";
  $("#cancel-order-edit").textContent = copiedDraft ? "取消复制" : "取消修改";
  $("#save-continue").hidden = Boolean(order);
  $("#save-order").textContent = order ? "保存修改" : "保存订单";
  $("#save-print").textContent = order ? "保存修改并进入打印" : "保存并进入打印";
  $("#delete-current-order").textContent = order ? "删除这张订单" : "清空当前订单";
  if ($("#view-new-order").classList.contains("active")) {
    $("#page-title").textContent = order ? "修改待打印订单" : copiedDraft ? "修改复制的今日订单" : titles["new-order"][0];
    $("#page-subtitle").textContent = order ? "可以增加、删除商品或修改数量，保存后重新等待打印" : copiedDraft ? "昨日商品已带入，可增加、删除或修改数量；点击保存后才生成今日订单" : titles["new-order"][1];
  }
}

async function openCopiedOrderDraft(draft) {
  await showView("new-order");
  setOrderEditUi(null, draft);
  $("#order-date").value = draft.orderDate;
  await chooseCustomer(draft.customerId);
  $("#order-note").value = draft.note || "";
  $("#order-items").innerHTML = "";
  draft.items.forEach((item) => addOrderItem({ productId: item.productId, productUnitId: item.productUnitId, unitSnapshot: item.unitSnapshot, quantity: item.quantity }));
  updateOrderTotal();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function editPendingOrder(id) {
  const order = await api(`/api/orders/${id}`);
  if (!["unprinted", "failed"].includes(order.print_status)) throw new Error("只有待打印订单可以修改");
  await showView("new-order");
  setOrderEditUi(order);
  $("#order-date").value = order.order_date;
  await chooseCustomer(order.customer_id);
  $("#order-note").value = order.note || "";
  $("#order-items").innerHTML = "";
  order.items.forEach((item) => addOrderItem({ productId: item.product_id, productUnitId: item.product_unit_id, unitSnapshot: item.unit_snapshot, quantity: item.quantity, unitPrice: item.unitPrice }));
  updateOrderTotal();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function orderPayload() {
  const items = $$(".item-row").map((row) => ({ productId: Number(row.querySelector(".item-product").value), productUnitId: Number(row.querySelector(".item-unit").value), quantity: row.querySelector(".item-quantity").value })).filter((item) => item.productId || item.quantity);
  return { orderDate: $("#order-date").value, customerId: Number($("#order-customer").value), note: $("#order-note").value, items, version: state.editingOrder?.version, sourceOrderId: state.copiedOrderDraft?.sourceOrderId || null };
}

async function saveOrder(mode = "stay") {
  const editing = state.editingOrder;
  const payload = orderPayload();
  let order;
  try {
    order = await api(editing ? `/api/orders/${editing.id}` : "/api/orders", { method: editing ? "PUT" : "POST", body: payload });
  } catch (error) {
    if (!editing && isNetworkError(error)) {
      queueOfflineOrder(payload);
      toast("当前离线：订单已保存在手机，联网后自动同步到电脑");
      setOrderEditUi();
      prepareOrderForm(true);
      return { offline: true };
    }
    throw error;
  }
  toast(`订单${order.order_no}已${editing ? "修改" : "保存"}`);
  setOrderEditUi();
  if (mode === "continue") {
    prepareOrderForm(true);
    $("#order-date").value = order.order_date;
  } else if (mode === "print") {
    state.selectedPrint = new Set([order.id]);
    await showView("print-center");
  } else await showView("dashboard");
  return order;
}

async function deletePendingOrder(id, orderNo, source) {
  if (!confirm(`确认永久删除订单${orderNo ? ` ${orderNo}` : ""}？\n订单、商品明细和关联付款都会直接删除，不可恢复，也不会进入月度汇总。`)) return false;
  await api(`/api/orders/${id}`, { method: "DELETE", body: { reason: `用户从${source}永久删除订单` } });
  state.selectedPrint.delete(Number(id));
  toast("订单已删除");
  return true;
}

async function loadPrintCenter() {
  const date = $("#work-date").value;
  state.todayOrders = await api(`/api/orders?date=${date}`);
  const pendingIds = new Set(state.todayOrders.filter((order) => ["unprinted", "failed"].includes(order.print_status)).map((order) => order.id));
  state.selectedPrint = new Set([...state.selectedPrint].filter((id) => pendingIds.has(id)));
  $("#print-orders").innerHTML = orderTable(state.todayOrders, { selectable: true, actions: false, editable: true, deletable: true });
  renderPrintPlan();
}

async function refreshPrintedOrders(orderIds = []) {
  orderIds.forEach((id) => state.selectedPrint.delete(Number(id)));
  if ($("#view-print-center").classList.contains("active")) await loadPrintCenter();
  if ($("#view-dashboard").classList.contains("active")) await loadDashboard();
}

function renderPrintPlan() {
  const selected = state.todayOrders.filter((order) => state.selectedPrint.has(order.id));
  const pages = [];
  for (let i = 0; i < selected.length; i += 3) pages.push(selected.slice(i, i + 3));
  $("#print-plan").innerHTML = pages.length ? pages.map((orders, index) => `<div class="print-plan-card"><b>第${index + 1}页：</b> ${[0,1,2].map((slot) => esc(orders[slot]?.customer_name_snapshot || "空白")).join(" / ")}</div>`).join("") : "";
}

async function loadProducts() {
  const products = await api(`/api/products?search=${encodeURIComponent($("#product-search").value)}`);
  $("#products-table").innerHTML = products.length ? `<table><thead><tr><th>商品名称</th><th>规格</th><th>销售单位</th><th class="money">基础价格</th><th>操作</th></tr></thead><tbody>${products.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.specification || "")}</td><td>${activeUnits(item).map((unit) => `${esc(unit.unit_name)} ${money(unit.price)}`).join(" / ")}</td><td class="money">${money(item.defaultPrice)}</td><td><button class="link-btn edit-product" data-id="${item.id}">修改商品</button><button class="link-btn manage-units" data-id="${item.id}">单位配置</button><button class="link-btn danger-link delete-product" data-id="${item.id}" data-name="${esc(item.name)}">删除</button></td></tr>`).join("")}</tbody></table>` : `<div class="empty">没有找到商品</div>`;
}

async function loadCustomers() {
  const customers = await api(`/api/customers?search=${encodeURIComponent($("#customer-search").value)}`);
  $("#customers-table").innerHTML = customers.length ? `<table><thead><tr><th>客户名称</th><th>联系人</th><th>电话</th><th>地址</th><th>操作</th></tr></thead><tbody>${customers.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.contact || "")}</td><td>${esc(item.phone || "")}</td><td>${esc(item.address || "")}</td><td><button class="link-btn edit-customer" data-id="${item.id}">修改</button><button class="link-btn danger-link delete-customer" data-id="${item.id}" data-name="${esc(item.name)}">删除</button></td></tr>`).join("")}</tbody></table>` : `<div class="empty">没有找到客户</div>`;
}

async function loadCustomerPricePage() {
  const selectedId = Number($("#price-customer").value || 0);
  if (!selectedId && $("#price-customer-input").value.trim()) throw new Error("请从联想列表中选择客户");
  const customerId = selectedId || Number(state.customers.find((item) => item.status === "active")?.id);
  if (!customerId) { $("#customer-prices-table").innerHTML = `<div class="empty">请先添加客户</div>`; return; }
  const customer = state.customers.find((item) => item.id === customerId);
  $("#price-customer").value = String(customerId);
  $("#price-customer-input").value = customerLabel(customer);
  const result = await api(`/api/customers/${customerId}/prices`);
  state.customerPriceRows = result.prices;
  renderCustomerPrices();
}

function renderCustomerPrices() {
  const keyword = $("#price-product-search").value.trim().toLowerCase();
  const rows = state.customerPriceRows.filter((row) => !keyword || row.name.toLowerCase().includes(keyword) || row.unit.toLowerCase().includes(keyword));
  $("#customer-prices-table").innerHTML = rows.length ? `<table><thead><tr><th>商品</th><th>销售单位</th><th>换算关系</th><th class="money">单位默认价</th><th>客户专属价格</th><th class="money">实际使用价格</th></tr></thead><tbody>${rows.map((row) => `<tr data-product-unit-id="${row.product_unit_id}"><td>${esc(row.name)}</td><td>${esc(row.unit)}</td><td>${row.is_base ? `1${esc(row.unit)}（基础）` : `1${esc(row.unit)}=${esc(row.conversion)}${esc(row.base_unit)}`}</td><td class="money">${money(row.defaultPrice)}</td><td><input class="customer-price-input" type="number" min="0" step="0.01" value="${esc(row.customerPrice ?? "")}" placeholder="留空用默认价"></td><td class="money effective-price">${money(row.effectivePrice)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">没有匹配商品</div>`;
}

async function saveCustomerPrices() {
  const customerId = Number($("#price-customer").value);
  if (!customerId) throw new Error("请选择客户");
  const prices = $$("#customer-prices-table tr[data-product-unit-id]").map((row) => ({ productUnitId: Number(row.dataset.productUnitId), price: row.querySelector(".customer-price-input").value }));
  const result = await api(`/api/customers/${customerId}/prices`, { method: "PUT", body: { prices } });
  if (Number($("#order-customer").value || 0) === customerId) {
    applyCustomerPrices(result);
    refreshUnsavedOrderPrices();
  }
  toast("客户专属价格已保存");
  state.customerPriceRows = result.prices;
  renderCustomerPrices();
}

async function loadLedger() {
  const month = $("#ledger-month").value || currentMonth();
  $("#ledger-month").value = month;
  const customerId = Number($("#ledger-customer").value || state.customers.find((item) => item.status === "active")?.id);
  if (!customerId) { $("#payments-table").innerHTML = `<div class="empty">请先添加客户</div>`; return; }
  setFilterCustomerPicker("ledger-customer-input", customerId);
  const ledger = await api(`/api/ledger?month=${month}&customerId=${customerId}`);
  $("#ledger-sales").textContent = money(ledger.summary.totalAmount);
  $("#ledger-paid").textContent = money(ledger.summary.paidAmount);
  $("#ledger-balance").textContent = money(ledger.summary.balance);
  $("#payments-table").innerHTML = ledger.payments.length ? `<table><thead><tr><th>收款日期</th><th>归属月份</th><th>来源</th><th class="money">金额</th><th>备注</th><th>操作</th></tr></thead><tbody>${ledger.payments.map((payment) => `<tr><td>${esc(payment.payment_date)}</td><td>${esc(payment.applied_month)}</td><td>${payment.kind === "order" ? `订单 ${esc(payment.order_no || "")}` : "手工收款"}</td><td class="money">${money(payment.amount)}</td><td>${esc(payment.note || "")}</td><td><button class="link-btn void-payment" data-id="${payment.id}">作废</button></td></tr>`).join("")}</tbody></table>` : `<div class="empty">本月暂无收款记录</div>`;
  $("#ledger-orders").innerHTML = orderTable(ledger.orders);
}

function showProductDialog(product = {}) {
  state.edit = { type: "product", id: product.id || null };
  $("#edit-save").textContent = "保存";
  $("#edit-fields").innerHTML = `<h2>${product.id ? "修改商品" : "新增商品"}</h2>
    <label>商品名称<input name="name" value="${esc(product.name || "")}" required></label>
    <label>规格<input name="specification" value="${esc(product.specification || "")}"></label><label>单位<input name="unit" value="${esc(product.unit || "")}" required></label>
    <label>默认价格（元）<input name="defaultPrice" type="number" min="0" step="0.01" value="${esc(product.defaultPrice || "")}" required></label>
    <label class="span-two">备注<input name="note" value="${esc(product.note || "")}"></label>`;
  $("#edit-dialog").showModal();
}

function unitEditRow(unit = {}) {
  if (unit.is_base) return `<div class="unit-edit-row base" data-id="${unit.id}"><b>基础单位</b><span>${esc(unit.unit_name)}</span><span>${money(unit.price)}</span><span>1${esc(unit.unit_name)}</span></div>`;
  return `<div class="unit-edit-row" data-id="${unit.id || ""}"><input class="unit-name" value="${esc(unit.unit_name || "")}" placeholder="例如：件" required><input class="unit-price" type="number" min="0" step="0.01" value="${esc(unit.price || "")}" placeholder="价格" required><input class="unit-conversion" type="number" min="0.001" step="0.001" value="${esc(unit.conversion || "")}" placeholder="含基础单位数量" required><select class="unit-status"><option value="active">使用中</option><option value="inactive" ${unit.status === "inactive" ? "selected" : ""}>停用</option></select></div>`;
}

function showUnitDialog(product) {
  state.edit = { type: "units", id: product.id };
  $("#edit-save").textContent = "保存";
  $("#edit-fields").innerHTML = `<h2>${esc(product.name)} · 销售单位配置</h2><p class="span-two">基础单位在“修改商品”中维护。增加整件单位时，例如填写：单位“件”、价格“120”、换算“24”，表示1件=24${esc(product.unit)}。</p><div class="unit-edit-head span-two"><b>单位</b><b>价格</b><b>换算成${esc(product.unit)}</b><b>状态</b></div><div id="unit-editor" class="span-two">${product.units.map(unitEditRow).join("")}</div><button id="add-unit-row" type="button" class="secondary span-two">＋ 增加销售单位</button>`;
  $("#edit-dialog").showModal();
}

function showCustomerDialog(customer = {}) {
  state.edit = { type: "customer", id: customer.id || null };
  $("#edit-save").textContent = "保存";
  $("#edit-fields").innerHTML = `<h2>${customer.id ? "修改客户" : "新增客户"}</h2>
    <label>客户名称<input name="name" value="${esc(customer.name || "")}" required></label>
    <label>联系人<input name="contact" value="${esc(customer.contact || "")}"></label><label>电话<input name="phone" value="${esc(customer.phone || "")}"></label>
    <label class="span-two">地址<input name="address" value="${esc(customer.address || "")}"></label>${customer.id ? `<label>打印顺序<input name="printSort" type="number" min="0" value="${esc(customer.print_sort ?? "")}"></label>` : ""}
    <label class="span-two">备注<input name="note" value="${esc(customer.note || "")}"></label>`;
  $("#edit-dialog").showModal();
}

async function deleteCatalogEntry(type, id, name) {
  const label = type === "product" ? "商品" : "客户";
  if (!confirm(`确认永久删除${label}“${name}”？\n删除后不会再出现在${label}管理和录单列表中，不能恢复；已经保存的历史订单仍保留当时的名称和价格快照。`)) return false;
  await api(`/api/${type === "product" ? "products" : "customers"}/${id}`, { method: "DELETE" });
  toast(`${label}已永久删除`);
  await loadCatalogs();
  if (type === "product") await loadProducts(); else await loadCustomers();
  return true;
}

function showCopyDialog() {
  state.edit = { type: "copy" };
  $("#edit-save").textContent = "进入修改";
  $("#edit-fields").innerHTML = `<h2>复制上一张订单</h2><label class="span-two">选择客户<div class="customer-picker"><input id="copy-customer-input" class="customer-autocomplete" autocomplete="off" placeholder="输入一个字搜索客户，点开显示全部" required><input id="copy-customer" name="customerId" type="hidden"><div class="customer-suggestions"></div></div></label><p class="span-two">输入客户名称中的任意一个字即可联想；点击输入框可查看全部客户。系统会找该客户当前日期之前最近的一张订单，带入今日订单修改页；不会直接生成订单。你可以增删商品或修改数量，最后点击保存才会生成今日订单；价格采用该客户今日价格。</p>`;
  $("#edit-dialog").showModal();
}

async function saveEditDialog(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData($("#edit-form")).entries());
  if (state.edit.type === "product") await api(state.edit.id ? `/api/products/${state.edit.id}` : "/api/products", { method: state.edit.id ? "PUT" : "POST", body: data });
  if (state.edit.type === "customer") await api(state.edit.id ? `/api/customers/${state.edit.id}` : "/api/customers", { method: state.edit.id ? "PUT" : "POST", body: data });
  if (state.edit.type === "units") {
    const units = $$("#unit-editor .unit-edit-row:not(.base)").map((row) => ({ id: Number(row.dataset.id || 0), unitName: row.querySelector(".unit-name").value, price: row.querySelector(".unit-price").value, conversion: row.querySelector(".unit-conversion").value, status: row.querySelector(".unit-status").value }));
    await api(`/api/products/${state.edit.id}/units`, { method: "PUT", body: { units } });
  }
  if (state.edit.type === "copy") {
    if (!Number(data.customerId)) throw new Error("请从客户联想列表中选择客户");
    const draft = await api(`/api/customers/${data.customerId}/copy-previous-order`, { method: "POST", body: { today: $("#work-date").value } });
    $("#edit-dialog").close();
    const changes = draft.priceChanges.length ? `，其中${draft.priceChanges.length}项已显示今日价` : "";
    await openCopiedOrderDraft(draft);
    toast(`上一张订单已带入编辑页${changes}`);
    return;
  }
  toast("保存成功");
  $("#edit-dialog").close();
  await loadCatalogs();
  if (state.edit.type === "product" || state.edit.type === "units") await loadProducts();
  if (state.edit.type === "customer") await loadCustomers();
}

async function loadHistory() {
  const params = new URLSearchParams();
  if ($("#history-from").value) params.set("dateFrom", $("#history-from").value);
  if ($("#history-to").value) params.set("dateTo", $("#history-to").value);
  if ($("#history-customer").value) params.set("customerId", $("#history-customer").value);
  if ($("#history-product").value) params.set("productId", $("#history-product").value);
  const orders = await api(`/api/orders?${params}`);
  $("#history-table").innerHTML = orderTable(orders);
}

async function showOrder(id) {
  const order = await api(`/api/orders/${id}`);
  $("#order-detail").innerHTML = `<h2>${esc(order.order_no)} · ${esc(order.customer_name_snapshot)}</h2><p>${esc(order.order_date)}　${printStatusTag(order.print_status)}　合计 <b>${money(order.totalAmount)}</b></p><div class="table-wrap detail-items"><table><thead><tr><th>商品</th><th>数量</th><th>单位</th><th class="money">当时单价</th><th class="money">金额</th></tr></thead><tbody>${order.items.map((item) => `<tr><td>${esc(item.product_name_snapshot)}</td><td>${esc(item.quantity)}</td><td>${esc(item.unit_snapshot)}</td><td class="money">${money(item.unitPrice)}</td><td class="money">${money(item.amount)}</td></tr>`).join("")}</tbody></table></div>${order.note ? `<p>备注：${esc(order.note)}</p>` : ""}`;
  $("#order-detail-dialog").showModal();
}

async function loadMonthly() {
  const month = $("#report-month").value || currentMonth();
  $("#report-month").value = month;
  const customerId = $("#report-customer").value;
  const report = await api(`/api/reports/monthly?month=${month}${customerId ? `&customerId=${customerId}` : ""}`);
  state.monthReport = report;
  const statusText = report.status === "closed" ? "本月已结账并锁定" : report.status === "reopened" ? "本月已重新打开，可更正订单" : "本月尚未结账";
  $("#month-status").className = `status-banner ${report.status === "closed" ? "closed" : ""}`;
  $("#month-status").innerHTML = `<b>${statusText}</b>${report.status === "closed" ? ` <button id="reopen-month" class="link-btn">重新打开</button>` : ""}`;
  $("#report-customer-count").textContent = report.totals.customerCount;
  $("#report-order-count").textContent = report.totals.orderCount;
  $("#report-total").textContent = money(report.totals.totalAmount);
  $("#report-paid").textContent = money(report.totals.paidAmount);
  $("#report-balance").textContent = money(report.totals.balance);
  $("#report-customers").innerHTML = report.customers.length ? `<table><thead><tr><th>客户</th><th>订单次数</th><th class="money">销售额</th><th class="money">已收款</th><th class="money">欠款</th></tr></thead><tbody>${report.customers.map((row) => `<tr><td>${esc(row.customer_name)}</td><td>${row.order_count}</td><td class="money">${money(row.totalAmount)}</td><td class="money">${money(row.paidAmount)}</td><td class="money">${money(row.balance)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">本月暂无订单或收款</div>`;
  const names = new Map(report.customers.map((row) => [row.customer_id, row.customer_name]));
  $("#report-items").innerHTML = report.items.length ? `<table><thead><tr>${customerId ? "" : "<th>客户</th>"}<th>商品</th><th>单位</th><th>数量</th><th class="money">金额</th></tr></thead><tbody>${report.items.map((row) => `<tr>${customerId ? "" : `<td>${esc(names.get(row.customer_id) || "")}</td>`}<td>${esc(row.product_name)}</td><td>${esc(row.unit)}</td><td>${esc(row.quantity)}</td><td class="money">${money(row.amount)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">本月暂无商品汇总</div>`;
}

async function loadSettings() {
  const settings = await api("/api/settings");
  for (const [key, value] of Object.entries(settings)) {
    const input = $(`#settings-form [name="${key}"]`);
    if (input) input.value = value;
  }
  updateLayoutControls();
}

async function loadMobileAccess() {
  const info = await api("/api/network-info");
  const container = $("#mobile-access-list");
  container.innerHTML = info.mobileUrls.length ? info.mobileUrls.map((url) => `<div class="mobile-url-card"><div><small>手机浏览器输入</small><strong>${esc(url)}</strong></div><button type="button" class="secondary copy-mobile-url" data-url="${esc(url)}">复制地址</button></div>`).join("") : `<div class="empty">暂时没有检测到局域网地址。请确认电脑已经连接Wi-Fi或网线，然后点击“刷新地址”。</div>`;
}

function updateLayoutControls() {
  const value = (name) => $(`#settings-form [name="${name}"]`)?.value || "0";
  const width = value("receipt_width_mm");
  const height = value("receipt_height_mm");
  const topBlank = value("receipt_top_blank_mm");
  const tableHeight = value("receipt_table_height_mm");
  const bottomBlank = value("receipt_bottom_blank_mm");
  const summary = $("#coordinate-summary");
  if (summary) summary.innerHTML = [1, 2, 3].map((slot) => {
    const slotTop = Number(value(`slot${slot}_position_top_mm`));
    const tableTop = slotTop + Number(topBlank);
    const tableBottom = tableTop + Number(tableHeight);
    return `<div class="coordinate-card"><b>第${slot}联：${esc(slotTop)}–${esc(slotTop + Number(height))}mm</b><span class="zone top-zone">顶部留白 ${esc(topBlank)}mm</span><span class="zone table-zone">实际订单表格 ${esc(tableHeight)}mm<br>绝对位置 ${esc(tableTop)}–${esc(tableBottom)}mm</span><span class="zone bottom-zone">底部留白 ${esc(bottomBlank)}mm</span><small>宽 ${esc(width)}mm · 总高 ${esc(height)}mm</small></div>`;
  }).join("");
  const itemWidths = ["item_product_width_mm", "item_quantity_width_mm", "item_unit_price_width_mm", "item_amount_width_mm"].map((name) => Number(value(name)));
  const itemGaps = ["item_gap_product_quantity_mm", "item_gap_quantity_price_mm", "item_gap_price_amount_mm"].map((name) => Number(value(name)));
  const itemLayoutWidth = [...itemWidths, ...itemGaps].reduce((total, current) => total + current, 0);
  const itemColumnWidth = (Number(width) - (2 * Number(value("content_padding_x_mm"))) - Number(value("column_gap_mm"))) / 2;
  const itemSummary = $("#item-column-summary");
  if (itemSummary) {
    const remaining = itemColumnWidth - itemLayoutWidth;
    itemSummary.classList.toggle("invalid", remaining < -0.001);
    itemSummary.innerHTML = `<b>单侧商品栏：可用 ${esc(itemColumnWidth.toFixed(1))}mm，当前各列共占 ${esc(itemLayoutWidth.toFixed(1))}mm</b><span>商品 ${esc(itemWidths[0])}　｜${esc(itemGaps[0])}｜　数量 ${esc(itemWidths[1])}　｜${esc(itemGaps[1])}｜　单价 ${esc(itemWidths[2])}　｜${esc(itemGaps[2])}｜　金额 ${esc(itemWidths[3])}</span><small>${remaining >= 0 ? `右侧还剩 ${esc(remaining.toFixed(1))}mm，不会挤出商品栏` : `已超出 ${esc(Math.abs(remaining).toFixed(1))}mm，请减小列宽或间距`}</small>`;
  }
}

async function savePrintSettings() {
  const settings = Object.fromEntries(new FormData($("#settings-form")).entries());
  const saved = await api("/api/settings", { method: "PUT", body: settings });
  toast("打印设置已保存");
  return saved;
}

async function previewImport() {
  const file = $("#excel-file").files[0];
  if (!file) throw new Error("请先选择Excel文件");
  const result = await api("/api/import/excel/preview", { method: "POST", body: await file.arrayBuffer(), headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  state.importToken = result.token;
  const issues = result.issues;
  const issueCount = issues.duplicateProducts.length + issues.duplicateCustomers.length + issues.embeddedPhones.length + issues.numericOnlyCustomers.length;
  $("#import-result").innerHTML = `<div class="import-summary"><b>检查完成</b><p>商品 ${result.counts.products} 条，客户 ${result.counts.customers} 条；发现 ${issueCount} 组需要关注的数据。</p><p>重名商品 ${issues.duplicateProducts.length} 组，重名客户 ${issues.duplicateCustomers.length} 组，名称含手机号 ${issues.embeddedPhones.length} 条，纯数字名称 ${issues.numericOnlyCustomers.length} 条。</p><label><input id="allow-duplicates" type="checkbox"> 确认保留Excel中的重名记录（系统会分配不同ID）</label><button id="commit-import" class="primary block">确认导入</button></div>`;
}

document.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".drag-item");
  if (!handle) return;
  const row = handle.closest(".item-row");
  if (!row) return;
  draggingOrderItem = row;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", "order-item");
  requestAnimationFrame(() => row.classList.add("dragging"));
});

document.addEventListener("dragover", (event) => {
  if (!draggingOrderItem) return;
  const row = event.target.closest("#order-items .item-row");
  if (!row || row === draggingOrderItem) return;
  event.preventDefault();
  clearOrderDragMarks();
  draggingOrderItem.classList.add("dragging");
  const rect = row.getBoundingClientRect();
  row.classList.add(event.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
});

document.addEventListener("drop", (event) => {
  if (!draggingOrderItem) return;
  const row = event.target.closest("#order-items .item-row");
  if (row && row !== draggingOrderItem) {
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    $("#order-items").insertBefore(draggingOrderItem, event.clientY < rect.top + rect.height / 2 ? row : row.nextElementSibling);
  }
  finishOrderItemDrag();
});

document.addEventListener("dragend", finishOrderItemDrag);

document.addEventListener("click", async (event) => {
  const go = event.target.closest("[data-go]")?.dataset.go;
  if (go) return showView(go);
  const nav = event.target.closest(".nav-item")?.dataset.view;
  if (nav) return showView(nav);
  try {
    if (event.target.closest(".customer-suggestion")) {
      const suggestion = event.target.closest(".customer-suggestion");
      if (suggestion.dataset.picker === "price-customer-input") await choosePriceCustomer(suggestion.dataset.id);
      else if (suggestion.dataset.picker === "copy-customer-input") chooseCopyCustomer(suggestion.dataset.id);
      else if (filterCustomerPickerTargets[suggestion.dataset.picker]) await chooseFilterCustomer(suggestion.dataset.picker, suggestion.dataset.id);
      else await chooseCustomer(suggestion.dataset.id);
      return;
    }
    if (event.target.closest(".filter-product-suggestion")) {
      chooseHistoryProduct(event.target.closest(".filter-product-suggestion").dataset.id);
      return;
    }
    if (event.target.closest(".product-suggestion")) {
      const suggestion = event.target.closest(".product-suggestion");
      chooseProduct(suggestion.closest(".item-row"), suggestion.dataset.id);
      return;
    }
    if (event.target.id === "add-item") addOrderItem();
    if (event.target.classList.contains("move-item-top")) moveOrderItemToTop(event.target.closest(".item-row"));
    if (event.target.classList.contains("insert-item-before")) insertBlankOrderItem(event.target.closest(".item-row"), "before");
    if (event.target.classList.contains("insert-item-after")) insertBlankOrderItem(event.target.closest(".item-row"), "after");
    if (event.target.classList.contains("remove-item")) { event.target.closest(".item-row").remove(); updateOrderTotal(); }
    if (event.target.closest("#quick-copy")) showCopyDialog();
    if (event.target.id === "new-product") showProductDialog();
    if (event.target.id === "new-customer") showCustomerDialog();
    if (event.target.classList.contains("edit-product")) showProductDialog(state.products.find((item) => item.id === Number(event.target.dataset.id)));
    if (event.target.classList.contains("manage-units")) showUnitDialog(state.products.find((item) => item.id === Number(event.target.dataset.id)));
    if (event.target.classList.contains("delete-product")) await deleteCatalogEntry("product", event.target.dataset.id, event.target.dataset.name);
    if (event.target.id === "add-unit-row") $("#unit-editor").insertAdjacentHTML("beforeend", unitEditRow());
    if (event.target.classList.contains("edit-customer")) showCustomerDialog(state.customers.find((item) => item.id === Number(event.target.dataset.id)));
    if (event.target.classList.contains("delete-customer")) await deleteCatalogEntry("customer", event.target.dataset.id, event.target.dataset.name);
    if (event.target.classList.contains("view-order")) await showOrder(event.target.dataset.id);
    if (event.target.classList.contains("edit-pending-order")) await editPendingOrder(event.target.dataset.id);
    if (event.target.classList.contains("mark-order-printed")) {
      const orderNo = event.target.dataset.orderNo || "";
      if (confirm(`确认订单 ${orderNo} 已经正常打印？\n确认后打印中心会显示“已打印”。`)) {
        await api("/api/print/record", { method: "POST", body: { orderIds: [Number(event.target.dataset.id)], status: "printed" } });
        state.selectedPrint.delete(Number(event.target.dataset.id));
        toast("订单已标记为已打印");
        await loadPrintCenter();
      }
    }
    if (event.target.classList.contains("delete-order")) {
      const activeView = $(".nav-item.active").dataset.view;
      if (await deletePendingOrder(event.target.dataset.id, event.target.dataset.orderNo, activeView === "print-center" ? "打印中心" : activeView === "history" ? "历史订单" : "今日订单")) {
        if (activeView === "print-center") await loadPrintCenter();
        else if (activeView === "history") await loadHistory();
        else await loadDashboard();
      }
    }
    if (event.target.classList.contains("toggle-order-paid")) {
      const paid = event.target.dataset.paid === "true";
      if (confirm(paid ? "确认这笔订单已经收到全款？" : "确认撤销这笔订单的已付款标记？")) {
        await api(`/api/orders/${event.target.dataset.id}/payment-status`, { method: "POST", body: { paid, paymentDate: $("#work-date").value } });
        toast(paid ? "已登记订单全款" : "已撤销付款标记");
        const active = $(".nav-item.active").dataset.view;
        if (active === "ledger") await loadLedger(); else if (active === "history") await loadHistory(); else await loadDashboard();
      }
    }
    if (event.target.id === "cancel-order-edit") { setOrderEditUi(); prepareOrderForm(true); $("#order-date").value = $("#work-date").value; }
    if (event.target.id === "delete-current-order") {
      if (state.editingOrder) {
        const editing = { ...state.editingOrder };
        if (await deletePendingOrder(editing.id, editing.orderNo, "新增订单页面")) {
          setOrderEditUi();
          prepareOrderForm(true);
          $("#order-date").value = $("#work-date").value;
          await showView("print-center");
        }
      } else if (confirm("确认清空当前尚未保存的订单内容？")) {
        prepareOrderForm(true);
        $("#order-date").value = $("#work-date").value;
        toast("当前录入已清空");
      }
    }
    if (event.target.id === "select-all-orders") {
      const pending = state.todayOrders.filter((order) => ["unprinted", "failed"].includes(order.print_status));
      const allSelected = pending.length > 0 && pending.every((order) => state.selectedPrint.has(order.id));
      state.selectedPrint = allSelected ? new Set() : new Set(pending.map((order) => order.id));
      await loadPrintCenter();
    }
    if (event.target.id === "mark-selected-printed") {
      const ids = state.todayOrders.filter((order) => state.selectedPrint.has(order.id) && ["unprinted", "failed"].includes(order.print_status)).map((order) => order.id);
      if (!ids.length) throw new Error("请先勾选要标记的待打印订单");
      if (confirm(`确认选中的 ${ids.length} 张订单都已经正常打印？\n确认后会一起显示为“已打印”。`)) {
        await api("/api/print/record", { method: "POST", body: { orderIds: ids, status: "printed" } });
        ids.forEach((id) => state.selectedPrint.delete(id));
        toast(`已将 ${ids.length} 张订单标记为已打印`);
        await loadPrintCenter();
      }
    }
    if (event.target.id === "preview-print") {
      const ids = [...state.selectedPrint];
      if (!ids.length) throw new Error("请至少选择一个订单");
      window.open(`/print.html?ids=${ids.join(",")}`, "_blank");
    }
    if (event.target.id === "history-search" || event.target.id === "load-report") await (event.target.id === "history-search" ? loadHistory() : loadMonthly());
    if (event.target.id === "load-customer-prices") await loadCustomerPricePage();
    if (event.target.id === "save-customer-prices") await saveCustomerPrices();
    if (event.target.id === "load-ledger") await loadLedger();
    if (event.target.classList.contains("void-payment")) {
      const reason = prompt("请输入作废收款记录的原因：");
      if (reason) { await api(`/api/payments/${event.target.dataset.id}/void`, { method: "POST", body: { reason } }); toast("收款记录已作废"); await loadLedger(); }
    }
    if (event.target.id === "close-month") {
      if (confirm(`确认结账${$("#report-month").value}？结账后本月订单将锁定。`)) { await api("/api/reports/monthly/close", { method: "POST", body: { month: $("#report-month").value } }); toast("本月已结账"); await loadMonthly(); }
    }
    if (event.target.id === "reopen-month") {
      const reason = prompt("请输入重新打开月份的原因：");
      if (reason) { await api("/api/reports/monthly/reopen", { method: "POST", body: { month: $("#report-month").value, reason } }); toast("月份已重新打开"); await loadMonthly(); }
    }
    if (event.target.id === "export-month") window.location.href = `/api/reports/monthly/export?month=${$("#report-month").value}`;
    if (event.target.id === "preview-import") await previewImport();
    if (event.target.id === "commit-import") {
      const allowDuplicates = Boolean($("#allow-duplicates")?.checked);
      const result = await api("/api/import/excel/commit", { method: "POST", body: { token: state.importToken, allowDuplicates } });
      $("#import-result").innerHTML = `<div class="import-summary"><b>导入完成</b><p>新增商品 ${result.products} 条，新增客户 ${result.customers} 条，跳过已有记录 ${result.skipped} 条。</p></div>`;
      await loadCatalogs();
    }
    if (event.target.id === "backup-now") { const result = await api("/api/backup", { method: "POST" }); $("#backup-result").innerHTML = `<div class="import-summary">备份已创建：${esc(result.filename)}</div>`; }
    if (event.target.id === "refresh-mobile-access") await loadMobileAccess();
    if (event.target.id === "install-mobile-app") await installMobileApp();
    if (event.target.classList.contains("copy-mobile-url")) {
      const url = event.target.dataset.url;
      try { await navigator.clipboard.writeText(url); toast("手机访问地址已复制"); }
      catch { prompt("请复制下面的手机访问地址：", url); }
    }
    if (event.target.id === "preview-layout") {
      const previewWindow = window.open("about:blank", "_blank");
      try {
        await savePrintSettings();
        const orders = await api(`/api/orders?date=${$("#work-date").value}`);
        if (!orders.length) throw new Error("当天没有订单，无法打开实际订单预览");
        previewWindow.location.href = `/print.html?ids=${orders.slice(0, 3).map((order) => order.id).join(",")}`;
      } catch (error) { previewWindow?.close(); throw error; }
    }
  } catch (error) { toast(error.message, true); }
  if (!event.target.closest(".product-picker")) $$(".product-suggestions.show").forEach((element) => element.classList.remove("show"));
  if (!event.target.closest(".customer-picker")) $$(".customer-suggestions.show").forEach((element) => element.classList.remove("show"));
});

document.addEventListener("change", (event) => {
  if (event.target.classList.contains("item-unit")) event.target.closest(".item-row").dataset.savedPrice = "";
  if (event.target.classList.contains("item-product") || event.target.classList.contains("item-quantity") || event.target.classList.contains("item-unit")) updateItemRow(event.target.closest(".item-row"));
  if (event.target.classList.contains("print-check")) {
    const id = Number(event.target.value);
    event.target.checked ? state.selectedPrint.add(id) : state.selectedPrint.delete(id);
    renderPrintPlan();
  }
});
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "orders-printed") return;
  refreshPrintedOrders(event.data.orderIds).catch((error) => toast(error.message, true));
});
window.addEventListener("storage", (event) => {
  if (event.key !== "order-print-status-changed" || !event.newValue) return;
  try {
    const message = JSON.parse(event.newValue);
    if (message.type === "orders-printed") refreshPrintedOrders(message.orderIds).catch((error) => toast(error.message, true));
  } catch {}
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && $("#view-print-center").classList.contains("active")) loadPrintCenter().catch((error) => toast(error.message, true));
});
document.addEventListener("wheel", (event) => {
  if (!event.target.classList.contains("item-quantity")) return;
  event.preventDefault();
  window.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: "auto" });
}, { passive: false, capture: true });
document.addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("item-quantity") || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const current = Number(event.target.value || 0);
  const next = Math.max(0.001, Math.round((current + (event.key === "ArrowUp" ? 0.5 : -0.5)) * 1000) / 1000);
  event.target.value = String(next);
  updateItemRow(event.target.closest(".item-row"));
});
document.addEventListener("input", (event) => {
  if (event.target.matches('#settings-form input[type="number"]')) updateLayoutControls();
  if (event.target.classList.contains("item-quantity")) updateItemRow(event.target.closest(".item-row"));
  if (event.target.classList.contains("item-product-input")) {
    const row = event.target.closest(".item-row");
    row.dataset.savedPrice = "";
    row.querySelector(".item-product").value = "";
    row.querySelector(".item-unit").innerHTML = "";
    updateItemRow(row);
    renderProductSuggestions(event.target);
  }
  if (event.target.classList.contains("customer-autocomplete")) {
    if (event.target.id === "order-customer-input") {
      $("#order-customer").value = "";
      state.customerPrices = new Map();
      $$(".item-row").forEach((row) => { if (!row.dataset.savedPrice) updateItemRow(row); });
    } else if (event.target.id === "price-customer-input") $("#price-customer").value = "";
    else if (event.target.id === "copy-customer-input") $("#copy-customer").value = "";
    else if (filterCustomerPickerTargets[event.target.id]) $(`#${filterCustomerPickerTargets[event.target.id]}`).value = "";
    renderCustomerSuggestions(event.target);
  }
  if (event.target.classList.contains("filter-product-autocomplete")) {
    $("#history-product").value = "";
    renderFilterProductSuggestions(event.target);
  }
  if (event.target.id === "price-product-search") renderCustomerPrices();
  if (event.target.classList.contains("customer-price-input")) {
    const row = event.target.closest("tr");
    const source = state.customerPriceRows.find((item) => item.product_unit_id === Number(row.dataset.productUnitId));
    row.querySelector(".effective-price").textContent = money(event.target.value === "" ? source.defaultPrice : event.target.value);
  }
});

document.addEventListener("focusin", (event) => {
  if (event.target.classList.contains("item-product-input")) renderProductSuggestions(event.target, true);
  if (event.target.classList.contains("filter-product-autocomplete")) renderFilterProductSuggestions(event.target, true);
  if (event.target.classList.contains("customer-autocomplete")) renderCustomerSuggestions(event.target, true);
});

document.addEventListener("keydown", (event) => {
  const openDialog = $("dialog[open]");
  if (event.key === "Escape" && openDialog) {
    event.preventDefault();
    closeDialog(openDialog);
    return;
  }
  if (event.target.classList.contains("customer-autocomplete")) {
    const suggestions = event.target.closest(".customer-picker").querySelector(".customer-suggestions");
    const options = [...suggestions.querySelectorAll(".customer-suggestion")];
    if (!options.length) return;
    let index = options.findIndex((option) => option.classList.contains("active"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[index]?.classList.remove("active");
      index = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
      options[index].classList.add("active");
      options[index].scrollIntoView({ block: "nearest" });
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[Math.max(index, 0)];
      if (event.target.id === "copy-customer-input") chooseCopyCustomer(chosen.dataset.id);
      else if (filterCustomerPickerTargets[event.target.id]) chooseFilterCustomer(event.target.id, chosen.dataset.id).catch((error) => toast(error.message, true));
      else {
        const action = event.target.id === "price-customer-input" ? choosePriceCustomer(chosen.dataset.id) : chooseCustomer(chosen.dataset.id);
        action.catch((error) => toast(error.message, true));
      }
    }
    if (event.key === "Escape") suggestions.classList.remove("show");
    return;
  }
  if (event.target.classList.contains("filter-product-autocomplete")) {
    const suggestions = event.target.closest(".product-picker").querySelector(".product-suggestions");
    const options = [...suggestions.querySelectorAll(".filter-product-suggestion")];
    if (!options.length) return;
    let index = options.findIndex((option) => option.classList.contains("active"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[index]?.classList.remove("active");
      index = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
      options[index].classList.add("active");
      options[index].scrollIntoView({ block: "nearest" });
    }
    if (event.key === "Enter") {
      event.preventDefault();
      chooseHistoryProduct(options[Math.max(index, 0)].dataset.id);
    }
    if (event.key === "Escape") suggestions.classList.remove("show");
    return;
  }
  if (!event.target.classList.contains("item-product-input")) return;
  const suggestions = event.target.closest(".product-picker").querySelector(".product-suggestions");
  const options = [...suggestions.querySelectorAll(".product-suggestion")];
  if (!options.length) return;
  let index = options.findIndex((option) => option.classList.contains("active"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    options[index]?.classList.remove("active");
    index = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
    options[index].classList.add("active");
    options[index].scrollIntoView({ block: "nearest" });
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const chosen = options[Math.max(index, 0)];
    chooseProduct(event.target.closest(".item-row"), chosen.dataset.id);
  }
  if (event.key === "Escape") suggestions.classList.remove("show");
});

$("#navigation").addEventListener("click", (event) => event.preventDefault());
$("#work-date").addEventListener("change", () => showView($(".nav-item.active").dataset.view));
$("#product-search").addEventListener("input", () => loadProducts().catch((error) => toast(error.message, true)));
$("#customer-search").addEventListener("input", () => loadCustomers().catch((error) => toast(error.message, true)));
$("#ledger-month").addEventListener("change", () => loadLedger().catch((error) => toast(error.message, true)));
$("#order-form").addEventListener("submit", (event) => { event.preventDefault(); saveOrder().catch((error) => toast(error.message, true)); });
$("#mobile-connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("#mobile-server-url").value.trim().replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+/i.test(value)) return toast("请输入完整电脑地址，例如 http://192.168.1.8:37831", true);
  localStorage.setItem(MOBILE_SERVER_KEY, value);
  closeDialog($("#mobile-connect-dialog"));
  init();
});
$("#mobile-connect-later").addEventListener("click", () => {
  closeDialog($("#mobile-connect-dialog"));
  // 允许已经缓存过商品和客户的手机在没有店内 Wi-Fi 时继续录单。
  init({ allowOfflineStart: true });
});
$("#save-continue").addEventListener("click", () => saveOrder("continue").catch((error) => toast(error.message, true)));
$("#save-print").addEventListener("click", () => saveOrder("print").catch((error) => toast(error.message, true)));
$("#edit-form").addEventListener("submit", saveEditDialog);
document.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) closeDialog(closeButton.closest("dialog"));
});
$$('dialog').forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
});
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await savePrintSettings(); }
  catch (error) { toast(error.message, true); }
});
$("#payment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/payments", { method: "POST", body: { customerId: Number($("#ledger-customer").value), paymentDate: $("#payment-date").value, appliedMonth: $("#ledger-month").value, amount: $("#payment-amount").value, note: $("#payment-note").value } });
    $("#payment-amount").value = "";
    $("#payment-note").value = "";
    toast("收款已登记");
    await loadLedger();
  } catch (error) { toast(error.message, true); }
});

async function init({ allowOfflineStart = false } = {}) {
  $("#work-date").value = localDate();
  $("#order-date").value = localDate();
  $("#report-month").value = currentMonth();
  $("#ledger-month").value = currentMonth();
  $("#payment-date").value = localDate();
  const first = new Date(`${currentMonth()}-01T00:00:00`);
  $("#history-from").value = new Date(first.getTime() - first.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $("#history-to").value = localDate();
  if (nativeMobileApp && !apiBaseUrl() && !allowOfflineStart) {
    $("#mobile-connect-dialog").showModal();
    return;
  }
  try {
    await loadCatalogs();
    const requestedView = new URLSearchParams(location.search).get("view");
    if (requestedView && titles[requestedView]) await showView(requestedView);
    else await loadDashboard();
    prepareOrderForm(true);
    await syncOfflineOrders();
    refreshOfflineSyncStatus();
  }
  catch (error) { toast(error.message, true); }
}

setupMobileAppInstall();
window.addEventListener("online", () => syncOfflineOrders());
setInterval(() => { syncOfflineOrders(); }, 30000);
init();
