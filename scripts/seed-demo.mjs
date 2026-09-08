import { Store } from "../src/db.mjs";

const store = new Store("data/demo.sqlite");

try {
  if (store.listProducts({ includeInactive: true }).length || store.listCustomers({ includeInactive: true }).length) {
    console.log("演示数据库已经有数据，没有重复添加。若要重新生成，请删除本地 data/demo.sqlite 后再运行。");
    process.exitCode = 0;
} else {
    const products = [
      store.createProduct({ name: "豆腐", specification: "基础装", unit: "斤", defaultPrice: "2.50" }),
      store.createProduct({ name: "豆皮", specification: "薄片", unit: "斤", defaultPrice: "5.00" }),
      store.createProduct({ name: "海带丝", specification: "切丝", unit: "斤", defaultPrice: "4.00" }),
      store.createProduct({ name: "素鸡", specification: "整件", unit: "件", defaultPrice: "12.00" }),
    ];
    const customers = [
      store.createCustomer({ name: "演示客户A", code: "C001", printSort: 1 }),
      store.createCustomer({ name: "演示客户B", code: "C002", printSort: 2 }),
      store.createCustomer({ name: "演示客户C", code: "C003", printSort: 3 }),
    ];

    store.updateCustomerPrices(customers[1].id, {
      prices: [{ productUnitId: products[0].id, price: "2.30" }],
    });

    store.createOrder({
      orderDate: "2026-09-08",
      customerId: customers[0].id,
      items: [
        { productId: products[0].id, quantity: "4" },
        { productId: products[1].id, quantity: "2.5" },
      ],
    });
    store.createOrder({
      orderDate: "2026-09-08",
      customerId: customers[1].id,
      items: [
        { productId: products[0].id, quantity: "6" },
        { productId: products[2].id, quantity: "3" },
      ],
    });
    store.createOrder({
      orderDate: "2026-09-08",
      customerId: customers[2].id,
      items: [{ productId: products[3].id, quantity: "2" }],
    });
    console.log("已生成虚构演示数据：4种商品、3个客户、3张订单。");
  }
} finally {
  store.close();
}
