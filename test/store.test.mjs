import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.mjs";

function fixture() {
  const store = new Store(":memory:");
  const product = store.createProduct({ name: "豆腐", unit: "斤", defaultPrice: "2.50" });
  const customer = store.createCustomer({ name: "演示客户A", code: "001", printSort: 1 });
  return { store, product, customer };
}

test("订单保存价格快照且金额正确", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-23", customerId: customer.id, items: [{ productId: product.id, quantity: "1.5" }] });
    assert.equal(order.totalAmount, "3.75");
    assert.equal(order.items[0].unitPrice, "2.50");
    assert.equal(order.items[0].quantity, "1.5");
  } finally { store.close(); }
});

test("同一手机离线同步标识重复上传不会生成重复订单", () => {
  const { store, product, customer } = fixture();
  try {
    const input = { orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "4.6" }] };
    const first = store.createOrder(input, { mobileClientId: "mobile-offline-001" });
    const retry = store.createOrder(input, { mobileClientId: "mobile-offline-001" });
    assert.equal(first.id, retry.id);
    assert.equal(store.listOrders({ date: "2026-08-24" }).length, 1);
    assert.equal(store.getOrder(first.id).items[0].quantity, "4.6");
  } finally { store.close(); }
});

test("订单号按当天最大序号递增并跳过隐藏作废订单占用的编号", () => {
  const { store, product, customer } = fixture();
  try {
    store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    const hidden = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    store.db.prepare("UPDATE orders SET order_no=?,status='voided' WHERE id=?").run("20260824-0003", hidden.id);
    assert.equal(store.listOrders({ date: "2026-08-24" }).length, 1);
    const created = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    assert.equal(created.order_no, "20260824-0004");
  } finally { store.close(); }
});

test("复制昨日订单采用今日商品价格且不改变历史价格", () => {
  const { store, product, customer } = fixture();
  try {
    const yesterday = store.createOrder({ orderDate: "2026-08-23", customerId: customer.id, items: [{ productId: product.id, quantity: "2" }] });
    store.updateProduct(product.id, { name: "豆腐", unit: "斤", defaultPrice: "3.00", status: "active", priceReason: "今日调价" });
    const result = store.copyYesterday(customer.id, "2026-08-24");
    assert.equal(store.getOrder(yesterday.id).items[0].unitPrice, "2.50");
    assert.equal(store.listOrders({ date: "2026-08-24" }).length, 0);
    const created = store.createOrder({ orderDate: result.orderDate, customerId: result.customerId, items: result.items, note: result.note }, { sourceOrderId: result.sourceOrderId });
    assert.equal(created.items[0].unitPrice, "3.00");
    assert.equal(created.totalAmount, "6.00");
    assert.equal(created.source_order_id, yesterday.id);
    assert.deepEqual(result.priceChanges, [{ product: "豆腐", yesterday: "2.50", today: "3.00" }]);
  } finally { store.close(); }
});

test("复制上一张订单会跳过没有下单的日期并取最近历史订单", () => {
  const { store, product, customer } = fixture();
  try {
    const older = store.createOrder({ orderDate: "2026-08-19", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    const latest = store.createOrder({ orderDate: "2026-08-22", customerId: customer.id, items: [{ productId: product.id, quantity: "3" }] });
    const copied = store.copyPreviousOrder(customer.id, "2026-08-24");
    assert.equal(copied.sourceOrderId, latest.id);
    assert.equal(copied.sourceOrderNo, latest.order_no);
    assert.equal(copied.sourceDate, "2026-08-22");
    assert.equal(copied.orderDate, "2026-08-24");
    assert.equal(copied.items[0].quantity, "3");
    assert.notEqual(copied.sourceOrderId, older.id);
  } finally { store.close(); }
});

test("待打印订单可以增删商品和修改数量且保留原商品价格", () => {
  const { store, product, customer } = fixture();
  try {
    const extra = store.createProduct({ name: "豆皮", unit: "斤", defaultPrice: "5.00" });
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "2" }] });
    store.updateProduct(product.id, { name: "豆腐", unit: "斤", defaultPrice: "3.00", status: "active", priceReason: "录单后调价" });
    const updated = store.updateOrder(order.id, { version: order.version, orderDate: order.order_date, customerId: customer.id, items: [{ productId: product.id, quantity: "3" }, { productId: extra.id, quantity: "2" }] });
    assert.equal(updated.itemCount, 2);
    assert.equal(updated.items[0].unitPrice, "2.50");
    assert.equal(updated.items[0].amount, "7.50");
    assert.equal(updated.items[1].unitPrice, "5.00");
    assert.equal(updated.totalAmount, "17.50");
    assert.equal(updated.version, 2);
  } finally { store.close(); }
});

test("已打印订单不能修改", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    store.recordPrint([order.id], "printed");
    assert.throws(() => store.updateOrder(order.id, { version: order.version, items: [{ productId: product.id, quantity: "2" }] }), /只有待打印订单/);
  } finally { store.close(); }
});

test("确认打印后订单状态持久保存为已打印", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    const batch = store.recordPrint([order.id], "printed");
    assert.equal(batch.status, "printed");
    assert.equal(store.getOrder(order.id).print_status, "printed");
    assert.equal(store.listOrders({ date: "2026-08-24" })[0].print_status, "printed");
    assert.equal(store.dashboard("2026-08-24").pendingPrint, 0);
  } finally { store.close(); }
});

test("多选订单可以一次标记为已打印", () => {
  const { store, product, customer } = fixture();
  try {
    const first = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "4.6" }] });
    const second = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "2.35" }] });
    const batch = store.recordPrint([first.id, second.id], "printed");
    assert.equal(batch.status, "printed");
    assert.equal(store.getOrder(first.id).print_status, "printed");
    assert.equal(store.getOrder(second.id).print_status, "printed");
    assert.equal(store.dashboard("2026-08-24").pendingPrint, 0);
  } finally { store.close(); }
});

test("删除订单会物理删除订单明细和关联收款且不进入月度汇总", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "2" }] });
    store.setOrderPaymentStatus(order.id, true, "2026-08-24");
    const deleted = store.deleteOrder(order.id, "用户从打印中心删除订单");
    assert.equal(deleted.deleted, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM orders WHERE id=?").get(order.id).count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id=?").get(order.id).count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id=?").get(order.id).count, 0);
    assert.equal(store.listOrders({ date: "2026-08-24" }).length, 0);
    assert.equal(store.listPayments({ month: "2026-08", customerId: customer.id }).length, 0);
    assert.equal(store.monthlyReport("2026-08").totals.orderCount, 0);
  } finally { store.close(); }
});

test("月结生成快照并锁定当月订单", () => {
  const { store, product, customer } = fixture();
  try {
    store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "4" }] });
    const report = store.closeMonth("2026-08");
    assert.equal(report.status, "closed");
    assert.equal(report.totals.orderCount, 1);
    assert.throws(() => store.createOrder({ orderDate: "2026-08-25", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] }), /已结账/);
    store.reopenMonth("2026-08", "补录遗漏订单");
    const newOrder = store.createOrder({ orderDate: "2026-08-25", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    assert.equal(newOrder.totalAmount, "2.50");
  } finally { store.close(); }
});

test("商品可永久删除且历史订单仍保留商品快照", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    const deleted = store.deleteProduct(product.id);
    assert.equal(deleted.deleted, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM products WHERE id=?").get(product.id).count, 0);
    assert.equal(store.listProducts({ includeInactive: true }).length, 0);
    assert.equal(store.getOrder(order.id).items[0].product_name_snapshot, "豆腐");
    assert.equal(store.monthlyReport("2026-08").totals.totalAmount, "2.50");
  } finally { store.close(); }
});

test("客户可永久删除且历史订单和收款仍保留客户快照", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "1" }] });
    store.setOrderPaymentStatus(order.id, true, "2026-08-24");
    const deleted = store.deleteCustomer(customer.id);
    assert.equal(deleted.deleted, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM customers WHERE id=?").get(customer.id).count, 0);
    assert.equal(store.listCustomers({ includeInactive: true }).length, 0);
    assert.equal(store.getOrder(order.id).customer_name_snapshot, "演示客户A");
    const report = store.monthlyReport("2026-08");
    assert.equal(report.customers[0].customer_name, "演示客户A");
    assert.equal(report.customers[0].paidAmount, "2.50");
  } finally { store.close(); }
});

test("商品和客户不填写编号时按1开始连续自动生成", () => {
  const store = new Store(":memory:");
  try {
    const first = store.createCustomer({ name: "新客户甲", printSort: "" });
    const second = store.createCustomer({ name: "新客户乙" });
    const product1 = store.createProduct({ name: "商品甲", unit: "袋", defaultPrice: "1" });
    const product2 = store.createProduct({ name: "商品乙", unit: "件", defaultPrice: "2" });
    assert.equal(first.code, "1");
    assert.equal(second.code, "2");
    assert.equal(product1.code, "1");
    assert.equal(product2.code, "2");
    assert.equal(first.print_sort, 1);
    assert.equal(second.print_sort, 2);
  } finally { store.close(); }
});

test("客户专属价格优先于商品默认价且历史订单不变", () => {
  const { store, product, customer } = fixture();
  try {
    const baseUnit = store.getProductUnits(product.id)[0];
    store.updateCustomerPrices(customer.id, { prices: [{ productUnitId: baseUnit.id, price: "2.20" }] });
    const first = store.createOrder({ orderDate: "2026-08-23", customerId: customer.id, items: [{ productId: product.id, quantity: "2" }] });
    assert.equal(first.items[0].unitPrice, "2.20");
    store.updateCustomerPrices(customer.id, { prices: [{ productUnitId: baseUnit.id, price: "2.80" }] });
    const copied = store.copyYesterday(customer.id, "2026-08-24");
    assert.equal(store.getOrder(first.id).items[0].unitPrice, "2.20");
    assert.equal(store.listOrders({ date: "2026-08-24" }).length, 0);
    const created = store.createOrder({ orderDate: copied.orderDate, customerId: copied.customerId, items: copied.items, note: copied.note }, { sourceOrderId: copied.sourceOrderId });
    assert.equal(created.items[0].unitPrice, "2.80");
    assert.deepEqual(copied.priceChanges, [{ product: "豆腐", yesterday: "2.20", today: "2.80" }]);
  } finally { store.close(); }
});

test("一个商品支持袋和件两个销售单位并分别计价", () => {
  const { store, customer } = fixture();
  try {
    const product = store.createProduct({ name: "赵都粉皮", unit: "袋", defaultPrice: "5.00" });
    store.updateProductUnits(product.id, { units: [{ unitName: "件", price: "120.00", conversion: "24", status: "active" }] });
    const units = store.getProductUnits(product.id);
    const bag = units.find((unit) => unit.unit_name === "袋");
    const carton = units.find((unit) => unit.unit_name === "件");
    assert.equal(carton.conversion, "24");
    store.updateCustomerPrices(customer.id, { prices: [{ productUnitId: carton.id, price: "115.00" }] });
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, productUnitId: bag.id, quantity: "10" }, { productId: product.id, productUnitId: carton.id, quantity: "3" }] });
    assert.equal(order.items[0].unit_snapshot, "袋");
    assert.equal(order.items[0].amount, "50.00");
    assert.equal(order.items[1].unit_snapshot, "件");
    assert.equal(order.items[1].unitPrice, "115.00");
    assert.equal(order.items[1].amount, "345.00");
    assert.equal(order.totalAmount, "395.00");
  } finally { store.close(); }
});

test("客户账本汇总手工收款和订单全款并保留收款流水", () => {
  const { store, product, customer } = fixture();
  try {
    const order = store.createOrder({ orderDate: "2026-08-24", customerId: customer.id, items: [{ productId: product.id, quantity: "4" }] });
    store.createPayment({ customerId: customer.id, paymentDate: "2026-08-24", appliedMonth: "2026-08", amount: "3.00", note: "微信" });
    let report = store.monthlyReport("2026-08", customer.id);
    assert.equal(report.customers[0].totalAmount, "10.00");
    assert.equal(report.customers[0].paidAmount, "3.00");
    assert.equal(report.customers[0].balance, "7.00");
    store.setOrderPaymentStatus(order.id, true, "2026-08-24");
    report = store.monthlyReport("2026-08", customer.id);
    assert.equal(report.customers[0].paidAmount, "13.00");
    assert.equal(store.listPayments({ month: "2026-08", customerId: customer.id }).length, 2);
    store.setOrderPaymentStatus(order.id, false);
    assert.equal(store.monthlyReport("2026-08", customer.id).customers[0].paidAmount, "3.00");
  } finally { store.close(); }
});

test("打印三联使用独立毫米坐标和固定外框尺寸", () => {
  const { store } = fixture();
  try {
    const defaults = store.getSettings();
    assert.deepEqual(
      [defaults.slot1_position_top_mm, defaults.slot2_position_top_mm, defaults.slot3_position_top_mm],
      ["0", "93", "186"],
    );
    assert.deepEqual(
      [defaults.receipt_top_blank_mm, defaults.receipt_table_height_mm, defaults.receipt_bottom_blank_mm, defaults.receipt_height_mm],
      ["8", "80", "5", "93"],
    );
    const settings = store.updateSettings({ paper_width_mm: "241", paper_height_mm: "279.4", slot1_position_top_mm: "0", slot2_position_top_mm: "93", slot3_position_top_mm: "186", receipt_width_mm: "217", receipt_height_mm: "93", receipt_top_blank_mm: "8", receipt_table_height_mm: "80", receipt_bottom_blank_mm: "5", content_padding_x_mm: "2", column_gap_mm: "10", item_product_width_mm: "32", item_quantity_width_mm: "14", item_unit_price_width_mm: "15", item_amount_width_mm: "28", item_gap_product_quantity_mm: "1", item_gap_quantity_price_mm: "1", item_gap_price_amount_mm: "1", base_font_size_mm: "3.7", line_height_mm: "4.2" });
    assert.equal(settings.slot2_position_top_mm, "93");
    assert.equal(settings.receipt_height_mm, "93");
    assert.equal(Number(settings.receipt_top_blank_mm) + Number(settings.receipt_table_height_mm) + Number(settings.receipt_bottom_blank_mm), 93);
    assert.equal(settings.item_amount_width_mm, "28");
    assert.throws(() => store.updateSettings({ receipt_table_height_mm: "79" }), /必须等于每联固定高度/);
    assert.throws(() => store.updateSettings({ slot3_position_top_mm: "200" }), /不能超出纸张高度/);
    assert.throws(() => store.updateSettings({ item_amount_width_mm: "80" }), /不能超过可用宽度/);
  } finally { store.close(); }
});
