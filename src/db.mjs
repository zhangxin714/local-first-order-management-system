import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import {
  BusinessError,
  assertText,
  optionalText,
  normalizeDate,
  normalizeMonth,
  monthBounds,
  previousDate,
  quantityToMilli,
  milliToQuantity,
  yuanToFen,
  fenToYuan,
  calculateAmountFen,
  formatOrderNumber,
} from "./domain.mjs";

const DEFAULT_SETTINGS = {
  business_name: "示例食品供应商",
  business_address: "演示地址（请在系统设置中修改）",
  business_phone: "000-0000-0000",
  printer_name: "EPSON LQ-630KII",
  paper_width_mm: "241",
  paper_height_mm: "279.4",
  slot_height_mm: "93",
  print_offset_x_mm: "0",
  print_offset_y_mm: "0",
  slot1_position_top_mm: "0",
  slot2_position_top_mm: "93",
  slot3_position_top_mm: "186",
  receipt_width_mm: "217",
  receipt_height_mm: "93",
  receipt_top_blank_mm: "8",
  receipt_table_height_mm: "80",
  receipt_bottom_blank_mm: "5",
  column_gap_mm: "10",
  content_padding_x_mm: "2",
  item_product_width_mm: "32",
  item_quantity_width_mm: "14",
  item_unit_price_width_mm: "15",
  item_amount_width_mm: "28",
  item_gap_product_quantity_mm: "1",
  item_gap_quantity_price_mm: "1",
  item_gap_price_amount_mm: "1",
  base_font_size_mm: "3.7",
  character_spacing_mm: "0",
  line_height_mm: "4.2",
};

function nowIso() {
  return new Date().toISOString();
}

function rowToProduct(row) {
  return row && { ...row, defaultPrice: fenToYuan(row.default_price_fen) };
}

function rowToProductUnit(row) {
  return row && { ...row, price: fenToYuan(row.price_fen), conversion: milliToQuantity(row.conversion_milli) };
}

function rowToOrder(row) {
  return row && {
    ...row,
    totalAmount: fenToYuan(row.total_amount_fen),
    itemCount: Number(row.item_count ?? 0),
  };
}

function rowToPayment(row) {
  return row && { ...row, amount: fenToYuan(row.amount_fen) };
}

export class Store {
  constructor(filename = path.resolve("data/orders.sqlite")) {
    this.filename = filename;
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (filename !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        specification TEXT,
        unit TEXT NOT NULL,
        default_price_fen INTEGER NOT NULL CHECK(default_price_fen >= 0),
        note TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

      CREATE TABLE IF NOT EXISTS product_price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        old_price_fen INTEGER NOT NULL,
        new_price_fen INTEGER NOT NULL,
        effective_at TEXT NOT NULL,
        changed_by TEXT NOT NULL DEFAULT '本机用户',
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS product_units (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        unit_name TEXT NOT NULL,
        price_fen INTEGER NOT NULL CHECK(price_fen >= 0),
        conversion_milli INTEGER NOT NULL DEFAULT 1000 CHECK(conversion_milli > 0),
        is_base INTEGER NOT NULL DEFAULT 0 CHECK(is_base IN (0,1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(product_id, unit_name)
      );
      CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id,status,id);

      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        contact TEXT,
        phone TEXT,
        address TEXT,
        note TEXT,
        print_sort INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
      CREATE INDEX IF NOT EXISTS idx_customers_sort ON customers(print_sort, code);

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT NOT NULL UNIQUE,
        order_date TEXT NOT NULL,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        customer_code_snapshot TEXT,
        customer_name_snapshot TEXT NOT NULL,
        total_amount_fen INTEGER NOT NULL CHECK(total_amount_fen >= 0),
        status TEXT NOT NULL DEFAULT 'saved' CHECK(status IN ('saved','voided')),
        print_status TEXT NOT NULL DEFAULT 'unprinted' CHECK(print_status IN ('unprinted','queued','printed','failed')),
        source_order_id INTEGER REFERENCES orders(id),
        note TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        voided_at TEXT,
        void_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
      CREATE INDEX IF NOT EXISTS idx_orders_customer_date ON orders(customer_id, order_date);

      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        line_no INTEGER NOT NULL,
        product_id INTEGER NOT NULL REFERENCES products(id),
        product_code_snapshot TEXT,
        product_name_snapshot TEXT NOT NULL,
        specification_snapshot TEXT,
        unit_snapshot TEXT NOT NULL,
        quantity_milli INTEGER NOT NULL CHECK(quantity_milli > 0),
        unit_price_fen INTEGER NOT NULL CHECK(unit_price_fen >= 0),
        amount_fen INTEGER NOT NULL CHECK(amount_fen >= 0),
        note TEXT,
        UNIQUE(order_id, line_no)
      );
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

      CREATE TABLE IF NOT EXISTS print_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_no TEXT NOT NULL UNIQUE,
        order_date TEXT,
        printer_name TEXT NOT NULL,
        paper_profile TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','printed','failed')),
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS print_batch_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL REFERENCES print_batches(id),
        order_id INTEGER NOT NULL REFERENCES orders(id),
        page_no INTEGER NOT NULL,
        slot_no INTEGER NOT NULL CHECK(slot_no BETWEEN 1 AND 3),
        sort_no INTEGER NOT NULL,
        printed_at TEXT,
        result TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        action TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT '本机用户'
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monthly_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT NOT NULL,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        order_count INTEGER NOT NULL,
        total_amount_fen INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','closed','reopened')),
        closed_at TEXT,
        closed_by TEXT,
        reopened_at TEXT,
        reopen_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(year_month, customer_id)
      );

      CREATE TABLE IF NOT EXISTS monthly_settlement_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_id INTEGER NOT NULL REFERENCES monthly_settlements(id) ON DELETE CASCADE,
        product_id INTEGER,
        product_name_snapshot TEXT NOT NULL,
        unit_snapshot TEXT NOT NULL,
        quantity_milli INTEGER NOT NULL,
        amount_fen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customer_product_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        product_unit_id INTEGER NOT NULL REFERENCES product_units(id),
        price_fen INTEGER NOT NULL CHECK(price_fen >= 0),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(customer_id, product_unit_id)
      );

      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        order_id INTEGER REFERENCES orders(id),
        payment_date TEXT NOT NULL,
        applied_month TEXT NOT NULL,
        amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
        kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','order')),
        note TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','voided')),
        created_at TEXT NOT NULL,
        voided_at TEXT,
        void_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payments_customer_month ON payments(customer_id, applied_month, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_active_order ON payments(order_id) WHERE order_id IS NOT NULL AND status='active';
    `);
    const orderColumns = new Set(this.db.prepare("PRAGMA table_info(orders)").all().map((row) => row.name));
    if (!orderColumns.has("payment_status")) this.db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid'))");
    if (!orderColumns.has("paid_at")) this.db.exec("ALTER TABLE orders ADD COLUMN paid_at TEXT");
    const itemColumns = new Set(this.db.prepare("PRAGMA table_info(order_items)").all().map((row) => row.name));
    if (!itemColumns.has("product_unit_id")) this.db.exec("ALTER TABLE order_items ADD COLUMN product_unit_id INTEGER REFERENCES product_units(id)");
    const insertBaseUnit = this.db.prepare(`INSERT OR IGNORE INTO product_units(product_id,unit_name,price_fen,conversion_milli,is_base,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const product of this.db.prepare("SELECT * FROM products WHERE deleted_at IS NULL").all()) insertBaseUnit.run(product.id, product.unit, product.default_price_fen, 1000, 1, product.status, nowIso(), nowIso());
    this.db.exec(`UPDATE order_items SET product_unit_id=(SELECT pu.id FROM product_units pu WHERE pu.product_id=order_items.product_id AND pu.unit_name=order_items.unit_snapshot LIMIT 1) WHERE product_unit_id IS NULL`);
    const customerPriceColumns = new Set(this.db.prepare("PRAGMA table_info(customer_product_prices)").all().map((row) => row.name));
    if (!customerPriceColumns.has("product_unit_id")) {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_customer_prices_customer;
        ALTER TABLE customer_product_prices RENAME TO customer_product_prices_legacy;
        CREATE TABLE customer_product_prices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          product_unit_id INTEGER NOT NULL REFERENCES product_units(id),
          price_fen INTEGER NOT NULL CHECK(price_fen >= 0),
          note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
          UNIQUE(customer_id,product_unit_id)
        );
        INSERT INTO customer_product_prices(customer_id,product_unit_id,price_fen,note,created_at,updated_at)
          SELECT old.customer_id,pu.id,old.price_fen,old.note,old.created_at,old.updated_at
          FROM customer_product_prices_legacy old JOIN product_units pu ON pu.product_id=old.product_id AND pu.is_base=1;
        DROP TABLE customer_product_prices_legacy;
      `);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_customer_prices_customer ON customer_product_prices(customer_id)");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(nowIso());
    const setting = this.db.prepare("INSERT OR IGNORE INTO app_settings(key, value, updated_at) VALUES(?, ?, ?)");
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) setting.run(key, value, nowIso());
    if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get()) {
      const update = this.db.prepare("UPDATE app_settings SET value=?, updated_at=? WHERE key=?");
      this.transaction(() => {
        for (const [key, value] of Object.entries({
          paper_width_mm: "241",
          paper_height_mm: "279.4",
          slot_height_mm: "93",
          slot1_position_top_mm: "0",
          slot2_position_top_mm: "93",
          slot3_position_top_mm: "186",
          receipt_height_mm: "93",
          receipt_top_blank_mm: "8",
          receipt_table_height_mm: "80",
          receipt_bottom_blank_mm: "5",
        })) update.run(value, nowIso(), key);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(nowIso());
      });
    }
    if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get()) {
      this.transaction(() => {
        const voidedOrders = this.db.prepare("SELECT id FROM orders WHERE status='voided'").all();
        for (const order of voidedOrders) {
          this.db.prepare("DELETE FROM payments WHERE order_id=?").run(order.id);
          this.db.prepare("DELETE FROM print_batch_items WHERE order_id=?").run(order.id);
          this.db.prepare("UPDATE orders SET source_order_id=NULL WHERE source_order_id=?").run(order.id);
          this.db.prepare("DELETE FROM order_items WHERE order_id=?").run(order.id);
          this.db.prepare("DELETE FROM orders WHERE id=?").run(order.id);
        }
        this.db.exec("DELETE FROM print_batches WHERE NOT EXISTS(SELECT 1 FROM print_batch_items pbi WHERE pbi.batch_id=print_batches.id)");
        this.db.exec("UPDATE products SET status='active',deleted_at=NULL WHERE deleted_at IS NULL");
        this.db.exec("UPDATE customers SET status='active',deleted_at=NULL WHERE deleted_at IS NULL");
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)").run(nowIso());
      });
    }
    if (!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get()) {
      const columns = new Set(this.db.prepare("PRAGMA table_info(orders)").all().map((row) => row.name));
      if (!columns.has("mobile_client_id")) this.db.exec("ALTER TABLE orders ADD COLUMN mobile_client_id TEXT");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_mobile_client_id ON orders(mobile_client_id) WHERE mobile_client_id IS NOT NULL");
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)").run(nowIso());
    }
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  audit(entityType, entityId, action, details = null) {
    this.db.prepare(`INSERT INTO audit_logs(entity_type, entity_id, action, details_json, created_at)
      VALUES(?, ?, ?, ?, ?)`)
      .run(entityType, entityId ?? null, action, details ? JSON.stringify(details) : null, nowIso());
  }

  getSettings() {
    return Object.fromEntries(this.db.prepare("SELECT key, value FROM app_settings").all().map((row) => [row.key, row.value]));
  }

  updateSettings(values) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const next = { ...this.getSettings(), ...Object.fromEntries(Object.entries(values || {}).filter(([key]) => allowed.has(key)).map(([key, value]) => [key, String(value)])) };
    const number = (key, label) => {
      const value = Number(next[key]);
      if (!Number.isFinite(value)) throw new BusinessError(`${label}必须是有效毫米数值`, "VALIDATION_ERROR");
      return value;
    };
    const paperWidth = number("paper_width_mm", "纸张宽度");
    const paperHeight = number("paper_height_mm", "纸张高度");
    const receiptWidth = number("receipt_width_mm", "每联宽度");
    const receiptHeight = number("receipt_height_mm", "每联高度");
    const topBlank = number("receipt_top_blank_mm", "每联顶部留白");
    const tableHeight = number("receipt_table_height_mm", "每联表格高度");
    const bottomBlank = number("receipt_bottom_blank_mm", "每联底部留白");
    const tops = [1, 2, 3].map((slot) => number(`slot${slot}_position_top_mm`, `第${slot}联顶部坐标`));
    if (paperWidth <= 0 || paperHeight <= 0 || receiptWidth <= 0 || receiptHeight <= 0) throw new BusinessError("纸张和每联宽高必须大于0", "VALIDATION_ERROR");
    if (receiptWidth > paperWidth) throw new BusinessError("每联宽度不能超过纸张宽度", "VALIDATION_ERROR");
    if (topBlank < 0 || tableHeight <= 0 || bottomBlank < 0) throw new BusinessError("顶部留白和底部留白不能小于0，表格高度必须大于0", "VALIDATION_ERROR");
    if (Math.abs(topBlank + tableHeight + bottomBlank - receiptHeight) > 0.001) throw new BusinessError("顶部留白 + 表格高度 + 底部留白必须等于每联固定高度", "VALIDATION_ERROR");
    if (tops.some((top) => top < 0 || top + receiptHeight > paperHeight + 0.001)) throw new BusinessError("三联顶部坐标加联高度不能超出纸张高度", "VALIDATION_ERROR");
    if (!(tops[0] < tops[1] && tops[1] < tops[2])) throw new BusinessError("三联顶部坐标必须从上到下依次增大", "VALIDATION_ERROR");
    if (tops[0] + receiptHeight > tops[1] + 0.001 || tops[1] + receiptHeight > tops[2] + 0.001) throw new BusinessError("三个93mm联区域不能互相重叠", "VALIDATION_ERROR");
    const contentPadding = number("content_padding_x_mm", "左右内容边距");
    const columnGap = number("column_gap_mm", "左右商品栏间距");
    const itemWidths = [
      number("item_product_width_mm", "商品名称列宽"),
      number("item_quantity_width_mm", "数量列宽"),
      number("item_unit_price_width_mm", "单价列宽"),
      number("item_amount_width_mm", "金额列宽"),
    ];
    const itemGaps = [
      number("item_gap_product_quantity_mm", "商品与数量间距"),
      number("item_gap_quantity_price_mm", "数量与单价间距"),
      number("item_gap_price_amount_mm", "单价与金额间距"),
    ];
    if (contentPadding < 0 || columnGap < 0 || itemWidths.some((value) => value <= 0) || itemGaps.some((value) => value < 0) || number("base_font_size_mm", "字体大小") <= 0 || number("line_height_mm", "行高") <= 0) throw new BusinessError("内容排版数值无效", "VALIDATION_ERROR");
    const singleColumnWidth = (receiptWidth - (2 * contentPadding) - columnGap) / 2;
    const itemLayoutWidth = [...itemWidths, ...itemGaps].reduce((total, value) => total + value, 0);
    if (singleColumnWidth <= 0) throw new BusinessError("左右内容边距和左右商品栏间距过大，没有可用的商品栏宽度", "VALIDATION_ERROR");
    if (itemLayoutWidth > singleColumnWidth + 0.001) throw new BusinessError(`单侧商品栏各列宽度和间距合计${itemLayoutWidth.toFixed(1)}mm，不能超过可用宽度${singleColumnWidth.toFixed(1)}mm`, "VALIDATION_ERROR");
    const stmt = this.db.prepare("INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    this.transaction(() => {
      for (const [key, value] of Object.entries(values || {})) {
        if (allowed.has(key)) stmt.run(key, String(value), nowIso());
      }
      this.audit("settings", null, "update", values);
    });
    return this.getSettings();
  }

  nextCode(table) {
    const rows = this.db.prepare(`SELECT code FROM ${table} WHERE deleted_at IS NULL`).all();
    let sequence = rows.reduce((highest, row) => {
      const value = Number(row.code);
      return Number.isSafeInteger(value) && value > highest ? value : highest;
    }, 0) + 1;
    let code = String(sequence);
    while (this.db.prepare(`SELECT 1 FROM ${table} WHERE code=?`).get(code)) code = String(++sequence);
    return code;
  }

  listProducts({ search = "", includeInactive = false } = {}) {
    const conditions = ["deleted_at IS NULL"];
    const params = [];
    if (!includeInactive) conditions.push("status='active'");
    if (search) {
      conditions.push("(name LIKE ? OR code LIKE ? OR unit LIKE ?)");
      const q = `%${search.trim()}%`;
      params.push(q, q, q);
    }
    return this.db.prepare(`SELECT * FROM products WHERE ${conditions.join(" AND ")} ORDER BY status, name, id`).all(...params).map((row) => ({ ...rowToProduct(row), units: this.getProductUnits(row.id, { includeInactive: true }) }));
  }

  getProductUnits(productId, { includeInactive = true } = {}) {
    const product = this.db.prepare("SELECT * FROM products WHERE id=? AND deleted_at IS NULL").get(Number(productId));
    if (!product) throw new BusinessError("商品不存在", "NOT_FOUND", 404);
    return this.db.prepare(`SELECT * FROM product_units WHERE product_id=?${includeInactive ? "" : " AND status='active'"} ORDER BY is_base DESC,id`).all(product.id).map(rowToProductUnit);
  }

  createProduct(input) {
    const timestamp = nowIso();
    const name = assertText(input.name, "商品名称", 100);
    const unit = assertText(input.unit, "单位", 20);
    const priceFen = yuanToFen(input.defaultPrice, "默认价格");
    const code = optionalText(input.code, 30) || this.nextCode("products");
    const result = this.db.prepare(`INSERT INTO products(code,name,specification,unit,default_price_fen,note,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(code, name, optionalText(input.specification, 100), unit, priceFen, optionalText(input.note), "active", timestamp, timestamp);
    const id = Number(result.lastInsertRowid);
    this.db.prepare(`INSERT INTO product_units(product_id,unit_name,price_fen,conversion_milli,is_base,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, unit, priceFen, 1000, 1, "active", timestamp, timestamp);
    this.audit("product", id, "create", { code, name, unit, priceFen });
    return rowToProduct(this.db.prepare("SELECT * FROM products WHERE id=?").get(id));
  }

  updateProduct(id, input) {
    const current = this.db.prepare("SELECT * FROM products WHERE id=? AND deleted_at IS NULL").get(id);
    if (!current) throw new BusinessError("商品不存在", "NOT_FOUND", 404);
    const name = assertText(input.name ?? current.name, "商品名称", 100);
    const unit = assertText(input.unit ?? current.unit, "单位", 20);
    const priceFen = input.defaultPrice == null ? current.default_price_fen : yuanToFen(input.defaultPrice, "默认价格");
    const status = "active";
    this.transaction(() => {
      this.db.prepare(`UPDATE products SET name=?, specification=?, unit=?, default_price_fen=?, note=?, status=?, updated_at=? WHERE id=?`)
        .run(name, optionalText(input.specification ?? current.specification, 100), unit, priceFen, optionalText(input.note ?? current.note), status, nowIso(), id);
      this.db.prepare(`UPDATE product_units SET unit_name=?,price_fen=?,conversion_milli=1000,status=?,updated_at=? WHERE product_id=? AND is_base=1`)
        .run(unit, priceFen, status, nowIso(), id);
      if (priceFen !== current.default_price_fen) {
        this.db.prepare(`INSERT INTO product_price_history(product_id,old_price_fen,new_price_fen,effective_at,reason) VALUES(?,?,?,?,?)`)
          .run(id, current.default_price_fen, priceFen, nowIso(), optionalText(input.priceReason, 200));
      }
      this.audit("product", id, "update", { before: current, after: { name, unit, priceFen, status } });
    });
    const product = rowToProduct(this.db.prepare("SELECT * FROM products WHERE id=?").get(id));
    return { ...product, units: this.getProductUnits(id, { includeInactive: true }) };
  }

  updateProductUnits(productId, input) {
    const product = this.db.prepare("SELECT * FROM products WHERE id=? AND deleted_at IS NULL").get(Number(productId));
    if (!product) throw new BusinessError("商品不存在", "NOT_FOUND", 404);
    if (!Array.isArray(input?.units)) throw new BusinessError("单位配置无效", "VALIDATION_ERROR");
    const current = new Map(this.db.prepare("SELECT * FROM product_units WHERE product_id=?").all(product.id).map((row) => [row.id, row]));
    this.transaction(() => {
      for (const entry of input.units) {
        const id = Number(entry.id || 0);
        const old = current.get(id);
        if (old?.is_base) continue;
        const unitName = assertText(entry.unitName, "销售单位", 20);
        const priceFen = yuanToFen(entry.price, "单位价格");
        const conversionMilli = quantityToMilli(entry.conversion);
        const status = entry.status === "inactive" ? "inactive" : "active";
        if (old) {
          this.db.prepare("UPDATE product_units SET unit_name=?,price_fen=?,conversion_milli=?,status=?,note=?,updated_at=? WHERE id=? AND product_id=?")
            .run(unitName, priceFen, conversionMilli, status, optionalText(entry.note, 200), nowIso(), old.id, product.id);
        } else {
          const timestamp = nowIso();
          this.db.prepare(`INSERT INTO product_units(product_id,unit_name,price_fen,conversion_milli,is_base,status,note,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(product.id, unitName, priceFen, conversionMilli, 0, status, optionalText(entry.note, 200), timestamp, timestamp);
        }
      }
      this.audit("product_unit", product.id, "update", { count: input.units.length });
    });
    return this.getProductUnits(product.id, { includeInactive: true });
  }

  setProductStatus(id, status) {
    return this.updateProduct(id, { ...this.db.prepare("SELECT * FROM products WHERE id=?").get(id), status, defaultPrice: fenToYuan(this.db.prepare("SELECT default_price_fen FROM products WHERE id=?").get(id)?.default_price_fen) });
  }

  deleteProduct(id) {
    const productId = Number(id);
    const current = this.db.prepare("SELECT * FROM products WHERE id=? AND deleted_at IS NULL").get(productId);
    if (!current) throw new BusinessError("商品不存在", "NOT_FOUND", 404);
    return this.transaction(() => {
      const timestamp = nowIso();
      const archiveCode = `__deleted_product_${productId}`;
      const archived = this.db.prepare(`INSERT INTO products(code,name,specification,unit,default_price_fen,note,status,created_at,updated_at,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(archiveCode, current.name, current.specification, current.unit, current.default_price_fen, "系统历史快照占位，不在商品库显示", "inactive", timestamp, timestamp, timestamp);
      const archivedProductId = Number(archived.lastInsertRowid);
      const archivedUnit = this.db.prepare(`INSERT INTO product_units(product_id,unit_name,price_fen,conversion_milli,is_base,status,note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(archivedProductId, current.unit, current.default_price_fen, 1000, 1, "inactive", "系统历史快照占位", timestamp, timestamp);
      const archivedUnitId = Number(archivedUnit.lastInsertRowid);
      this.db.prepare("UPDATE order_items SET product_id=?,product_unit_id=? WHERE product_id=?").run(archivedProductId, archivedUnitId, productId);
      this.db.prepare("UPDATE monthly_settlement_items SET product_id=? WHERE product_id=?").run(archivedProductId, productId);
      this.db.prepare("DELETE FROM customer_product_prices WHERE product_unit_id IN (SELECT id FROM product_units WHERE product_id=?)").run(productId);
      this.db.prepare("DELETE FROM product_price_history WHERE product_id=?").run(productId);
      this.db.prepare("DELETE FROM product_units WHERE product_id=?").run(productId);
      this.db.prepare("DELETE FROM products WHERE id=?").run(productId);
      this.audit("product", productId, "delete", { name: current.name });
      return { id: productId, name: current.name, deleted: true };
    });
  }

  listCustomers({ search = "", includeInactive = false } = {}) {
    const conditions = ["deleted_at IS NULL"];
    const params = [];
    if (!includeInactive) conditions.push("status='active'");
    if (search) {
      conditions.push("(name LIKE ? OR code LIKE ? OR phone LIKE ?)");
      const q = `%${search.trim()}%`;
      params.push(q, q, q);
    }
    return this.db.prepare(`SELECT * FROM customers WHERE ${conditions.join(" AND ")} ORDER BY print_sort, code, id`).all(...params);
  }

  getCustomerPrices(customerId) {
    const customer = this.db.prepare("SELECT id,name FROM customers WHERE id=? AND deleted_at IS NULL").get(Number(customerId));
    if (!customer) throw new BusinessError("客户不存在", "NOT_FOUND", 404);
    const prices = this.db.prepare(`SELECT p.id AS product_id,p.code,p.name,p.unit AS base_unit,pu.id AS product_unit_id,pu.unit_name AS unit,
      pu.price_fen AS default_price_fen,pu.conversion_milli,pu.is_base,cp.price_fen AS customer_price_fen,cp.note
      FROM products p JOIN product_units pu ON pu.product_id=p.id
      LEFT JOIN customer_product_prices cp ON cp.product_unit_id=pu.id AND cp.customer_id=?
      WHERE p.deleted_at IS NULL AND pu.status='active' ORDER BY p.status,p.name,p.id,pu.is_base DESC,pu.id`).all(customer.id).map((row) => ({
        ...row,
        defaultPrice: fenToYuan(row.default_price_fen),
        conversion: milliToQuantity(row.conversion_milli),
        customerPrice: row.customer_price_fen == null ? null : fenToYuan(row.customer_price_fen),
        effectivePrice: fenToYuan(row.customer_price_fen ?? row.default_price_fen),
      }));
    return { customer, prices };
  }

  updateCustomerPrices(customerId, input) {
    const customer = this.db.prepare("SELECT id,name FROM customers WHERE id=? AND deleted_at IS NULL").get(Number(customerId));
    if (!customer) throw new BusinessError("客户不存在", "NOT_FOUND", 404);
    if (!Array.isArray(input?.prices)) throw new BusinessError("价格数据无效", "VALIDATION_ERROR");
    const upsert = this.db.prepare(`INSERT INTO customer_product_prices(customer_id,product_unit_id,price_fen,note,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(customer_id,product_unit_id) DO UPDATE SET price_fen=excluded.price_fen,note=excluded.note,updated_at=excluded.updated_at`);
    const remove = this.db.prepare("DELETE FROM customer_product_prices WHERE customer_id=? AND product_unit_id=?");
    this.transaction(() => {
      for (const entry of input.prices) {
        const productUnitId = Number(entry.productUnitId);
        if (!this.db.prepare("SELECT 1 FROM product_units WHERE id=?").get(productUnitId)) throw new BusinessError("商品单位不存在", "VALIDATION_ERROR");
        if (entry.price === "" || entry.price == null) remove.run(customer.id, productUnitId);
        else {
          const priceFen = yuanToFen(entry.price, "客户专属价格");
          const timestamp = nowIso();
          upsert.run(customer.id, productUnitId, priceFen, optionalText(entry.note, 200), timestamp, timestamp);
        }
      }
      this.audit("customer_price", customer.id, "update", { count: input.prices.length });
    });
    return this.getCustomerPrices(customer.id);
  }

  resolvePriceFen(customerId, productUnit) {
    const custom = this.db.prepare("SELECT price_fen FROM customer_product_prices WHERE customer_id=? AND product_unit_id=?").get(Number(customerId), Number(productUnit.id));
    return custom?.price_fen ?? productUnit.price_fen;
  }

  createCustomer(input) {
    const timestamp = nowIso();
    const name = assertText(input.name, "客户名称", 120);
    const nextSort = Number(this.db.prepare("SELECT COALESCE(MAX(print_sort),0)+1 AS next FROM customers").get().next);
    const rawPrintSort = String(input.printSort ?? "").trim();
    const printSort = rawPrintSort === "" ? nextSort : Number(rawPrintSort);
    if (!Number.isInteger(printSort) || printSort < 0) throw new BusinessError("打印顺序必须是0或更大的整数", "VALIDATION_ERROR");
    const code = optionalText(input.code, 30) || this.nextCode("customers");
    const result = this.db.prepare(`INSERT INTO customers(code,name,contact,phone,address,note,print_sort,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(code, name, optionalText(input.contact, 80), optionalText(input.phone, 80), optionalText(input.address), optionalText(input.note), printSort, "active", timestamp, timestamp);
    const id = Number(result.lastInsertRowid);
    this.audit("customer", id, "create", { code, name, printSort });
    return this.db.prepare("SELECT * FROM customers WHERE id=?").get(id);
  }

  updateCustomer(id, input) {
    const current = this.db.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").get(id);
    if (!current) throw new BusinessError("客户不存在", "NOT_FOUND", 404);
    const status = "active";
    const rawPrintSort = String(input.printSort ?? "").trim();
    const printSort = rawPrintSort === "" ? Number(current.print_sort) : Number(rawPrintSort);
    if (!Number.isInteger(printSort) || printSort < 0) throw new BusinessError("打印顺序必须是0或更大的整数", "VALIDATION_ERROR");
    this.db.prepare(`UPDATE customers SET code=?,name=?,contact=?,phone=?,address=?,note=?,print_sort=?,status=?,updated_at=? WHERE id=?`)
      .run(optionalText(input.code ?? current.code, 30) || current.code, assertText(input.name ?? current.name, "客户名称", 120), optionalText(input.contact ?? current.contact, 80), optionalText(input.phone ?? current.phone, 80), optionalText(input.address ?? current.address), optionalText(input.note ?? current.note), printSort, status, nowIso(), id);
    this.audit("customer", id, "update", { before: current });
    return this.db.prepare("SELECT * FROM customers WHERE id=?").get(id);
  }

  deleteCustomer(id) {
    const customerId = Number(id);
    const current = this.db.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").get(customerId);
    if (!current) throw new BusinessError("客户不存在", "NOT_FOUND", 404);
    return this.transaction(() => {
      const timestamp = nowIso();
      const archiveCode = `__deleted_customer_${customerId}`;
      const archived = this.db.prepare(`INSERT INTO customers(code,name,contact,phone,address,note,print_sort,status,created_at,updated_at,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(archiveCode, current.name, current.contact, current.phone, current.address, "系统历史快照占位，不在客户库显示", current.print_sort, "inactive", timestamp, timestamp, timestamp);
      const archivedCustomerId = Number(archived.lastInsertRowid);
      this.db.prepare("UPDATE orders SET customer_id=? WHERE customer_id=?").run(archivedCustomerId, customerId);
      this.db.prepare("UPDATE payments SET customer_id=? WHERE customer_id=?").run(archivedCustomerId, customerId);
      this.db.prepare("UPDATE monthly_settlements SET customer_id=? WHERE customer_id=?").run(archivedCustomerId, customerId);
      this.db.prepare("DELETE FROM customer_product_prices WHERE customer_id=?").run(customerId);
      this.db.prepare("DELETE FROM customers WHERE id=?").run(customerId);
      this.audit("customer", customerId, "delete", { name: current.name });
      return { id: customerId, name: current.name, deleted: true };
    });
  }

  isMonthClosed(month) {
    return Boolean(this.db.prepare("SELECT 1 FROM monthly_settlements WHERE year_month=? AND status='closed' LIMIT 1").get(normalizeMonth(month)));
  }

  assertMonthOpen(date) {
    const month = normalizeDate(date).slice(0, 7);
    if (this.isMonthClosed(month)) throw new BusinessError(`${month}已结账，不能修改订单`, "MONTH_CLOSED", 409);
  }

  createOrder(input, { sourceOrderId = null, mobileClientId = null } = {}) {
    const date = normalizeDate(input.orderDate);
    this.assertMonthOpen(date);
    const customer = this.db.prepare("SELECT * FROM customers WHERE id=? AND status='active' AND deleted_at IS NULL").get(Number(input.customerId));
    if (!customer) throw new BusinessError("请选择有效客户", "VALIDATION_ERROR");
    if (!Array.isArray(input.items) || input.items.length === 0) throw new BusinessError("请至少添加一项商品", "VALIDATION_ERROR");

    const normalizedMobileClientId = mobileClientId == null ? null : assertText(mobileClientId, "手机离线订单标识", 100);
    return this.transaction(() => {
      if (normalizedMobileClientId) {
        const existing = this.db.prepare("SELECT id FROM orders WHERE mobile_client_id=?").get(normalizedMobileClientId);
        if (existing) return this.getOrder(existing.id);
      }
      const preparedItems = input.items.map((item, index) => {
        const product = this.db.prepare("SELECT * FROM products WHERE id=? AND status='active' AND deleted_at IS NULL").get(Number(item.productId));
        if (!product) throw new BusinessError(`第${index + 1}行商品无效或已停用`, "VALIDATION_ERROR");
        const unit = item.productUnitId
          ? this.db.prepare("SELECT * FROM product_units WHERE id=? AND product_id=? AND status='active'").get(Number(item.productUnitId), product.id)
          : this.db.prepare("SELECT * FROM product_units WHERE product_id=? AND is_base=1 AND status='active'").get(product.id);
        if (!unit) throw new BusinessError(`第${index + 1}行销售单位无效或已停用`, "VALIDATION_ERROR");
        const quantityMilli = quantityToMilli(item.quantity);
        const unitPriceFen = this.resolvePriceFen(customer.id, unit);
        return { product, unit, quantityMilli, unitPriceFen, amountFen: calculateAmountFen(quantityMilli, unitPriceFen), note: optionalText(item.note, 200) };
      });
      const totalFen = preparedItems.reduce((sum, item) => sum + item.amountFen, 0);
      const numberPrefix = `${date.replaceAll("-", "")}-`;
      const existingNumbers = this.db.prepare("SELECT order_no FROM orders WHERE order_date=?").all(date);
      let sequence = existingNumbers.reduce((highest, row) => {
        if (!String(row.order_no).startsWith(numberPrefix)) return highest;
        const value = Number(String(row.order_no).slice(numberPrefix.length));
        return Number.isSafeInteger(value) && value > highest ? value : highest;
      }, 0) + 1;
      let orderNo = formatOrderNumber(date, sequence);
      while (this.db.prepare("SELECT 1 FROM orders WHERE order_no=?").get(orderNo)) {
        sequence += 1;
        orderNo = formatOrderNumber(date, sequence);
      }
      const timestamp = nowIso();
      const result = this.db.prepare(`INSERT INTO orders(order_no,order_date,customer_id,customer_code_snapshot,customer_name_snapshot,total_amount_fen,status,print_status,source_order_id,note,mobile_client_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderNo, date, customer.id, customer.code, customer.name, totalFen, "saved", "unprinted", sourceOrderId, optionalText(input.note), normalizedMobileClientId, timestamp, timestamp);
      const orderId = Number(result.lastInsertRowid);
      const insertItem = this.db.prepare(`INSERT INTO order_items(order_id,line_no,product_id,product_unit_id,product_code_snapshot,product_name_snapshot,specification_snapshot,unit_snapshot,quantity_milli,unit_price_fen,amount_fen,note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      preparedItems.forEach((item, index) => insertItem.run(orderId, index + 1, item.product.id, item.unit.id, item.product.code, item.product.name, item.product.specification, item.unit.unit_name, item.quantityMilli, item.unitPriceFen, item.amountFen, item.note));
      this.audit("order", orderId, sourceOrderId ? "copy" : "create", { orderNo, totalFen, sourceOrderId, mobileClientId: normalizedMobileClientId });
      return this.getOrder(orderId);
    });
  }

  updateOrder(id, input) {
    const orderId = Number(id);
    const current = this.db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    if (!current) throw new BusinessError("订单不存在", "NOT_FOUND", 404);
    if (current.status !== "saved") throw new BusinessError("已作废订单不能修改", "ORDER_LOCKED", 409);
    if (!['unprinted', 'failed'].includes(current.print_status)) throw new BusinessError("只有待打印订单可以修改", "ORDER_PRINTED", 409);
    this.assertMonthOpen(current.order_date);

    const date = normalizeDate(input.orderDate ?? current.order_date);
    this.assertMonthOpen(date);
    const expectedVersion = Number(input.version ?? current.version);
    if (expectedVersion !== Number(current.version)) throw new BusinessError("订单已被其他操作修改，请重新打开", "VERSION_CONFLICT", 409);
    const customer = this.db.prepare("SELECT * FROM customers WHERE id=? AND deleted_at IS NULL").get(Number(input.customerId ?? current.customer_id));
    if (!customer || (customer.status !== "active" && customer.id !== current.customer_id)) throw new BusinessError("请选择有效客户", "VALIDATION_ERROR");
    if (!Array.isArray(input.items) || input.items.length === 0) throw new BusinessError("请至少保留一项商品", "VALIDATION_ERROR");

    const oldItems = this.db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY line_no").all(orderId);
    return this.transaction(() => {
      const latest = this.db.prepare("SELECT version FROM orders WHERE id=?").get(orderId);
      if (Number(latest?.version) !== expectedVersion) throw new BusinessError("订单已被其他操作修改，请重新打开", "VERSION_CONFLICT", 409);
      const preparedItems = input.items.map((item, index) => {
        const productId = Number(item.productId);
        const product = this.db.prepare("SELECT * FROM products WHERE id=? AND deleted_at IS NULL").get(productId);
        const unit = item.productUnitId
          ? this.db.prepare("SELECT * FROM product_units WHERE id=? AND product_id=?").get(Number(item.productUnitId), productId)
          : this.db.prepare("SELECT * FROM product_units WHERE product_id=? AND is_base=1").get(productId);
        const oldIndex = customer.id === current.customer_id ? oldItems.findIndex((oldItem) => oldItem.product_id === productId && (oldItem.product_unit_id ? oldItem.product_unit_id === unit?.id : oldItem.unit_snapshot === unit?.unit_name)) : -1;
        const old = oldIndex >= 0 ? oldItems.splice(oldIndex, 1)[0] : null;
        if (!product || !unit || (product.status !== "active" && !old) || (unit.status !== "active" && !old)) throw new BusinessError(`第${index + 1}行商品或销售单位无效或已停用`, "VALIDATION_ERROR");
        const quantityMilli = quantityToMilli(item.quantity);
        const unitPriceFen = old?.unit_price_fen ?? this.resolvePriceFen(customer.id, unit);
        return { product, unit, quantityMilli, unitPriceFen, amountFen: calculateAmountFen(quantityMilli, unitPriceFen), note: optionalText(item.note, 200) };
      });
      const totalFen = preparedItems.reduce((sum, item) => sum + item.amountFen, 0);
      const timestamp = nowIso();
      this.db.prepare(`UPDATE orders SET order_date=?,customer_id=?,customer_code_snapshot=?,customer_name_snapshot=?,total_amount_fen=?,print_status='unprinted',note=?,updated_at=?,version=version+1 WHERE id=?`)
        .run(date, customer.id, customer.code, customer.name, totalFen, optionalText(input.note), timestamp, orderId);
      if (current.payment_status === "paid") this.db.prepare("UPDATE payments SET customer_id=?,applied_month=?,amount_fen=? WHERE order_id=? AND status='active'").run(customer.id, date.slice(0, 7), totalFen, orderId);
      this.db.prepare("DELETE FROM order_items WHERE order_id=?").run(orderId);
      const insertItem = this.db.prepare(`INSERT INTO order_items(order_id,line_no,product_id,product_unit_id,product_code_snapshot,product_name_snapshot,specification_snapshot,unit_snapshot,quantity_milli,unit_price_fen,amount_fen,note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      preparedItems.forEach((item, index) => insertItem.run(orderId, index + 1, item.product.id, item.unit.id, item.product.code, item.product.name, item.product.specification, item.unit.unit_name, item.quantityMilli, item.unitPriceFen, item.amountFen, item.note));
      this.audit("order", orderId, "update", { beforeVersion: current.version, totalFen, itemCount: preparedItems.length });
      return this.getOrder(orderId);
    });
  }

  getOrder(id) {
    const order = this.db.prepare(`SELECT o.*, c.print_sort, COUNT(oi.id) AS item_count
      FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items oi ON oi.order_id=o.id
      WHERE o.id=? GROUP BY o.id`).get(Number(id));
    if (!order) throw new BusinessError("订单不存在", "NOT_FOUND", 404);
    const items = this.db.prepare("SELECT * FROM order_items WHERE order_id=? ORDER BY line_no").all(Number(id)).map((item) => ({
      ...item,
      quantity: milliToQuantity(item.quantity_milli),
      unitPrice: fenToYuan(item.unit_price_fen),
      amount: fenToYuan(item.amount_fen),
    }));
    return { ...rowToOrder(order), items };
  }

  listOrders({ date, dateFrom, dateTo, customerId, productId, status = "saved", printStatus, search = "" } = {}) {
    const conditions = ["1=1"];
    const params = [];
    if (date) { conditions.push("o.order_date=?"); params.push(normalizeDate(date)); }
    if (dateFrom) { conditions.push("o.order_date>=?"); params.push(normalizeDate(dateFrom)); }
    if (dateTo) { conditions.push("o.order_date<=?"); params.push(normalizeDate(dateTo)); }
    if (customerId) { conditions.push("o.customer_id=?"); params.push(Number(customerId)); }
    if (productId) { conditions.push("EXISTS(SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.product_id=?)"); params.push(Number(productId)); }
    if (status) { conditions.push("o.status=?"); params.push(status); }
    if (printStatus) { conditions.push("o.print_status=?"); params.push(printStatus); }
    if (search) { conditions.push("(o.order_no LIKE ? OR o.customer_name_snapshot LIKE ?)"); const q = `%${search}%`; params.push(q, q); }
    return this.db.prepare(`SELECT o.*, c.print_sort, COUNT(oi.id) AS item_count
      FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items oi ON oi.order_id=o.id
      WHERE ${conditions.join(" AND ")} GROUP BY o.id ORDER BY o.order_date DESC, c.print_sort, o.id`).all(...params).map(rowToOrder);
  }

  copyOrderFromSource(sourceId, customerId, today) {
    const normalizedToday = normalizeDate(today);
    const source = { id: Number(sourceId) };
    const order = this.getOrder(source.id);
    const priceChanges = [];
    const items = order.items.map((item) => {
      const product = this.db.prepare("SELECT * FROM products WHERE id=? AND status='active' AND deleted_at IS NULL").get(item.product_id);
      if (!product) throw new BusinessError(`${item.product_name_snapshot}已停用，不能复制`, "PRODUCT_INACTIVE", 409);
      const unit = item.product_unit_id
        ? this.db.prepare("SELECT * FROM product_units WHERE id=? AND product_id=? AND status='active'").get(item.product_unit_id, product.id)
        : this.db.prepare("SELECT * FROM product_units WHERE product_id=? AND unit_name=? AND status='active'").get(product.id, item.unit_snapshot);
      if (!unit) throw new BusinessError(`${item.product_name_snapshot}的${item.unit_snapshot}单位已停用，不能复制`, "PRODUCT_UNIT_INACTIVE", 409);
      const todayPriceFen = this.resolvePriceFen(customerId, unit);
      const label = unit.unit_name === product.unit ? product.name : `${product.name}（${unit.unit_name}）`;
      if (todayPriceFen !== item.unit_price_fen) priceChanges.push({ product: label, yesterday: fenToYuan(item.unit_price_fen), today: fenToYuan(todayPriceFen) });
      return { productId: product.id, productUnitId: unit.id, quantity: item.quantity };
    });
    return {
      sourceOrderId: order.id,
      sourceOrderNo: order.order_no,
      sourceDate: order.order_date,
      orderDate: normalizedToday,
      customerId: Number(customerId),
      customerName: order.customer_name_snapshot,
      note: `复制自${order.order_date}订单${order.order_no}`,
      items,
      priceChanges,
    };
  }

  copyYesterday(customerId, today) {
    const sourceDate = previousDate(today);
    const source = this.db.prepare(`SELECT id FROM orders WHERE customer_id=? AND order_date=? AND status='saved' ORDER BY id DESC LIMIT 1`).get(Number(customerId), sourceDate);
    if (!source) throw new BusinessError("该客户没有昨日订单", "NO_YESTERDAY_ORDER", 404);
    return this.copyOrderFromSource(source.id, customerId, today);
  }

  copyPreviousOrder(customerId, today) {
    const normalizedToday = normalizeDate(today);
    const source = this.db.prepare(`SELECT id FROM orders
      WHERE customer_id=? AND order_date<? AND status='saved'
      ORDER BY order_date DESC, id DESC LIMIT 1`).get(Number(customerId), normalizedToday);
    if (!source) throw new BusinessError("该客户没有可复制的历史订单", "NO_PREVIOUS_ORDER", 404);
    return this.copyOrderFromSource(source.id, customerId, normalizedToday);
  }

  deleteOrder(id, reason) {
    const order = this.db.prepare("SELECT * FROM orders WHERE id=?").get(Number(id));
    if (!order) throw new BusinessError("订单不存在", "NOT_FOUND", 404);
    this.assertMonthOpen(order.order_date);
    const why = assertText(reason, "删除原因", 300);
    return this.transaction(() => {
      const orderId = Number(id);
      const batchIds = this.db.prepare("SELECT DISTINCT batch_id FROM print_batch_items WHERE order_id=?").all(orderId).map((row) => row.batch_id);
      this.db.prepare("DELETE FROM payments WHERE order_id=?").run(orderId);
      this.db.prepare("DELETE FROM print_batch_items WHERE order_id=?").run(orderId);
      this.db.prepare("UPDATE orders SET source_order_id=NULL WHERE source_order_id=?").run(orderId);
      this.db.prepare("DELETE FROM order_items WHERE order_id=?").run(orderId);
      this.db.prepare("DELETE FROM orders WHERE id=?").run(orderId);
      for (const batchId of batchIds) this.db.prepare("DELETE FROM print_batches WHERE id=? AND NOT EXISTS(SELECT 1 FROM print_batch_items WHERE batch_id=?)").run(batchId, batchId);
      this.audit("order", orderId, "delete", { orderNo: order.order_no, reason: why });
      return { id: orderId, orderNo: order.order_no, deleted: true };
    });
  }

  voidOrder(id, reason) {
    return this.deleteOrder(id, reason);
  }

  monthlyReport(month, customerId = null) {
    const normalized = normalizeMonth(month);
    const { start, next } = monthBounds(normalized);
    const customerClause = customerId ? " AND o.customer_id=?" : "";
    const params = customerId ? [start, next, Number(customerId)] : [start, next];
    const customers = this.db.prepare(`SELECT o.customer_id, o.customer_name_snapshot AS customer_name,
      COUNT(DISTINCT o.id) AS order_count, SUM(o.total_amount_fen) AS total_amount_fen
      FROM orders o WHERE o.order_date>=? AND o.order_date<? AND o.status='saved'${customerClause}
      GROUP BY o.customer_id, o.customer_name_snapshot ORDER BY total_amount_fen DESC, order_count DESC`).all(...params)
      .map((row) => ({ ...row }));
    const paymentParams = customerId ? [normalized, Number(customerId)] : [normalized];
    const paymentClause = customerId ? " AND p.customer_id=?" : "";
    const paymentRows = this.db.prepare(`SELECT p.customer_id,c.name AS customer_name,SUM(p.amount_fen) AS paid_amount_fen
      FROM payments p JOIN customers c ON c.id=p.customer_id
      WHERE p.applied_month=? AND p.status='active'${paymentClause} GROUP BY p.customer_id,c.name`).all(...paymentParams);
    const customerMap = new Map(customers.map((row) => [row.customer_id, row]));
    for (const payment of paymentRows) {
      if (!customerMap.has(payment.customer_id)) {
        const row = { customer_id: payment.customer_id, customer_name: payment.customer_name, order_count: 0, total_amount_fen: 0 };
        customers.push(row);
        customerMap.set(payment.customer_id, row);
      }
      customerMap.get(payment.customer_id).paid_amount_fen = Number(payment.paid_amount_fen);
    }
    for (const customer of customers) {
      customer.paid_amount_fen = Number(customer.paid_amount_fen || 0);
      customer.balance_fen = Number(customer.total_amount_fen) - customer.paid_amount_fen;
      customer.totalAmount = fenToYuan(customer.total_amount_fen);
      customer.paidAmount = fenToYuan(customer.paid_amount_fen);
      customer.balance = fenToYuan(customer.balance_fen);
    }
    customers.sort((a, b) => Number(b.total_amount_fen) - Number(a.total_amount_fen) || Number(b.order_count) - Number(a.order_count));
    const itemParams = customerId ? [start, next, Number(customerId)] : [start, next];
    const items = this.db.prepare(`SELECT o.customer_id, oi.product_id, oi.product_name_snapshot AS product_name,
      oi.unit_snapshot AS unit, SUM(oi.quantity_milli) AS quantity_milli, SUM(oi.amount_fen) AS amount_fen
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE o.order_date>=? AND o.order_date<? AND o.status='saved'${customerClause}
      GROUP BY o.customer_id, oi.product_id, oi.product_name_snapshot, oi.unit_snapshot
      ORDER BY o.customer_id, oi.product_name_snapshot`).all(...itemParams)
      .map((row) => ({ ...row, quantity: milliToQuantity(row.quantity_milli), amount: fenToYuan(row.amount_fen) }));
    const settlementRows = this.db.prepare("SELECT * FROM monthly_settlements WHERE year_month=?").all(normalized);
    return {
      month: normalized,
      status: settlementRows.some((row) => row.status === "closed") ? "closed" : settlementRows.some((row) => row.status === "reopened") ? "reopened" : "open",
      customers,
      items,
      totals: {
        customerCount: customers.length,
        orderCount: customers.reduce((sum, row) => sum + Number(row.order_count), 0),
        totalAmountFen: customers.reduce((sum, row) => sum + Number(row.total_amount_fen), 0),
        totalAmount: fenToYuan(customers.reduce((sum, row) => sum + Number(row.total_amount_fen), 0)),
        paidAmountFen: customers.reduce((sum, row) => sum + Number(row.paid_amount_fen), 0),
        paidAmount: fenToYuan(customers.reduce((sum, row) => sum + Number(row.paid_amount_fen), 0)),
        balanceFen: customers.reduce((sum, row) => sum + Number(row.balance_fen), 0),
        balance: fenToYuan(customers.reduce((sum, row) => sum + Number(row.balance_fen), 0)),
      },
    };
  }

  listPayments({ month, customerId } = {}) {
    const conditions = ["p.status='active'"];
    const params = [];
    if (month) { conditions.push("p.applied_month=?"); params.push(normalizeMonth(month)); }
    if (customerId) { conditions.push("p.customer_id=?"); params.push(Number(customerId)); }
    return this.db.prepare(`SELECT p.*,c.name AS customer_name,o.order_no
      FROM payments p JOIN customers c ON c.id=p.customer_id LEFT JOIN orders o ON o.id=p.order_id
      WHERE ${conditions.join(" AND ")} ORDER BY p.payment_date DESC,p.id DESC`).all(...params).map(rowToPayment);
  }

  createPayment(input) {
    const customer = this.db.prepare("SELECT id,name FROM customers WHERE id=? AND deleted_at IS NULL").get(Number(input.customerId));
    if (!customer) throw new BusinessError("请选择有效客户", "VALIDATION_ERROR");
    const paymentDate = normalizeDate(input.paymentDate);
    const appliedMonth = normalizeMonth(input.appliedMonth || paymentDate.slice(0, 7));
    const amountFen = yuanToFen(input.amount, "收款金额");
    if (amountFen <= 0) throw new BusinessError("收款金额必须大于0", "VALIDATION_ERROR");
    const timestamp = nowIso();
    const result = this.db.prepare(`INSERT INTO payments(customer_id,payment_date,applied_month,amount_fen,kind,note,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(customer.id, paymentDate, appliedMonth, amountFen, "manual", optionalText(input.note, 300), "active", timestamp);
    const id = Number(result.lastInsertRowid);
    this.audit("payment", id, "create", { customerId: customer.id, paymentDate, appliedMonth, amountFen });
    return rowToPayment(this.db.prepare(`SELECT p.*,c.name AS customer_name,NULL AS order_no FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.id=?`).get(id));
  }

  voidPayment(id, reason) {
    const payment = this.db.prepare("SELECT * FROM payments WHERE id=?").get(Number(id));
    if (!payment) throw new BusinessError("收款记录不存在", "NOT_FOUND", 404);
    if (payment.status === "voided") return rowToPayment(payment);
    const why = assertText(reason, "作废原因", 300);
    this.transaction(() => {
      this.db.prepare("UPDATE payments SET status='voided',voided_at=?,void_reason=? WHERE id=?").run(nowIso(), why, Number(id));
      if (payment.order_id) this.db.prepare("UPDATE orders SET payment_status='unpaid',paid_at=NULL,updated_at=?,version=version+1 WHERE id=?").run(nowIso(), payment.order_id);
      this.audit("payment", Number(id), "void", { reason: why });
    });
    return rowToPayment(this.db.prepare("SELECT * FROM payments WHERE id=?").get(Number(id)));
  }

  setOrderPaymentStatus(id, paid, paymentDate = null) {
    const order = this.db.prepare("SELECT * FROM orders WHERE id=? AND status='saved'").get(Number(id));
    if (!order) throw new BusinessError("订单不存在", "NOT_FOUND", 404);
    if (Boolean(paid) === (order.payment_status === "paid")) return this.getOrder(id);
    this.transaction(() => {
      if (paid) {
        const date = normalizeDate(paymentDate || order.order_date);
        const timestamp = nowIso();
        this.db.prepare(`INSERT INTO payments(customer_id,order_id,payment_date,applied_month,amount_fen,kind,note,status,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(order.customer_id, order.id, date, order.order_date.slice(0, 7), order.total_amount_fen, "order", `订单${order.order_no}已付款`, "active", timestamp);
        this.db.prepare("UPDATE orders SET payment_status='paid',paid_at=?,updated_at=?,version=version+1 WHERE id=?").run(timestamp, timestamp, order.id);
      } else {
        this.db.prepare("UPDATE payments SET status='voided',voided_at=?,void_reason='撤销订单已付款标记' WHERE order_id=? AND status='active'").run(nowIso(), order.id);
        this.db.prepare("UPDATE orders SET payment_status='unpaid',paid_at=NULL,updated_at=?,version=version+1 WHERE id=?").run(nowIso(), order.id);
      }
      this.audit("order", order.id, paid ? "mark_paid" : "mark_unpaid", null);
    });
    return this.getOrder(id);
  }

  customerLedger(month, customerId) {
    const normalized = normalizeMonth(month);
    const report = this.monthlyReport(normalized, customerId);
    const { next } = monthBounds(normalized);
    return { month: normalized, customerId: Number(customerId), summary: report.customers[0] || { totalAmount: "0.00", paidAmount: "0.00", balance: "0.00", order_count: 0 }, payments: this.listPayments({ month: normalized, customerId }), orders: this.listOrders({ dateFrom: `${normalized}-01`, dateTo: previousDate(next), customerId }) };
  }

  closeMonth(month) {
    const normalized = normalizeMonth(month);
    if (this.isMonthClosed(normalized)) throw new BusinessError("该月份已经结账", "MONTH_CLOSED", 409);
    const report = this.monthlyReport(normalized);
    if (report.customers.length === 0) throw new BusinessError("该月份没有可结账订单", "NO_ORDERS", 409);
    this.transaction(() => {
      for (const customer of report.customers) {
        this.db.prepare("DELETE FROM monthly_settlements WHERE year_month=? AND customer_id=?").run(normalized, customer.customer_id);
        const result = this.db.prepare(`INSERT INTO monthly_settlements(year_month,customer_id,order_count,total_amount_fen,status,closed_at,closed_by,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(normalized, customer.customer_id, customer.order_count, customer.total_amount_fen, "closed", nowIso(), "本机用户", nowIso());
        const settlementId = Number(result.lastInsertRowid);
        const insertItem = this.db.prepare(`INSERT INTO monthly_settlement_items(settlement_id,product_id,product_name_snapshot,unit_snapshot,quantity_milli,amount_fen) VALUES(?,?,?,?,?,?)`);
        report.items.filter((item) => item.customer_id === customer.customer_id).forEach((item) => insertItem.run(settlementId, item.product_id, item.product_name, item.unit, item.quantity_milli, item.amount_fen));
      }
      this.audit("month", null, "close", { month: normalized, totals: report.totals });
    });
    return this.monthlyReport(normalized);
  }

  reopenMonth(month, reason) {
    const normalized = normalizeMonth(month);
    const why = assertText(reason, "重新打开原因", 300);
    const result = this.db.prepare("UPDATE monthly_settlements SET status='reopened',reopened_at=?,reopen_reason=? WHERE year_month=? AND status='closed'").run(nowIso(), why, normalized);
    if (!result.changes) throw new BusinessError("该月份尚未结账", "MONTH_NOT_CLOSED", 409);
    this.audit("month", null, "reopen", { month: normalized, reason: why });
    return this.monthlyReport(normalized);
  }

  dashboard(date) {
    const normalized = normalizeDate(date);
    const row = this.db.prepare(`SELECT COUNT(*) AS order_count,
      COALESCE(SUM(total_amount_fen),0) AS total_amount_fen,
      SUM(CASE WHEN print_status IN ('unprinted','failed') THEN 1 ELSE 0 END) AS pending_print
      FROM orders WHERE order_date=? AND status='saved'`).get(normalized);
    return { date: normalized, orderCount: Number(row.order_count), pendingPrint: Number(row.pending_print || 0), totalAmount: fenToYuan(row.total_amount_fen) };
  }

  recordPrint(orderIds, status = "printed", errorMessage = null) {
    const ids = [...new Set((orderIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) throw new BusinessError("没有选择订单", "VALIDATION_ERROR");
    const orders = ids.map((id) => this.getOrder(id));
    const settings = this.getSettings();
    const timestamp = nowIso();
    return this.transaction(() => {
      const batchNo = `P${timestamp.replace(/\D/g, "").slice(0, 14)}`;
      const batch = this.db.prepare(`INSERT INTO print_batches(batch_no,order_date,printer_name,paper_profile,page_count,status,error_message,created_at,completed_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(batchNo, orders[0]?.order_date || null, settings.printer_name, `${settings.paper_width_mm}x${settings.paper_height_mm}mm`, Math.ceil(orders.length / 3), status, errorMessage, timestamp, timestamp);
      const batchId = Number(batch.lastInsertRowid);
      const insert = this.db.prepare("INSERT INTO print_batch_items(batch_id,order_id,page_no,slot_no,sort_no,printed_at,result) VALUES(?,?,?,?,?,?,?)");
      orders.forEach((order, index) => {
        insert.run(batchId, order.id, Math.floor(index / 3) + 1, (index % 3) + 1, index + 1, timestamp, status);
        this.db.prepare("UPDATE orders SET print_status=?,updated_at=? WHERE id=?").run(status === "printed" ? "printed" : "failed", timestamp, order.id);
      });
      this.audit("print_batch", batchId, status, { orderIds: ids });
      return { id: batchId, batchNo, pageCount: Math.ceil(orders.length / 3), status };
    });
  }

  bulkImportCatalog({ products = [], customers = [] }, { allowDuplicates = false } = {}) {
    return this.transaction(() => {
      const inserted = { products: 0, customers: 0, skipped: 0 };
      for (const product of products) {
        const exact = this.db.prepare("SELECT id FROM products WHERE name=? AND unit=? AND default_price_fen=? AND deleted_at IS NULL").get(product.name.trim(), product.unit.trim(), yuanToFen(product.price, "商品价格"));
        if (exact && !allowDuplicates) { inserted.skipped++; continue; }
        this.createProduct({ name: product.name, unit: product.unit, defaultPrice: product.price, specification: product.specification, note: "Excel导入" });
        inserted.products++;
      }
      for (const customer of customers) {
        const exact = this.db.prepare("SELECT id FROM customers WHERE name=? AND deleted_at IS NULL").get(customer.name.trim());
        if (exact && !allowDuplicates) { inserted.skipped++; continue; }
        this.createCustomer({ name: customer.name, phone: customer.phone, printSort: customer.printSort, code: customer.code, note: "Excel导入" });
        inserted.customers++;
      }
      this.audit("import", null, "catalog", inserted);
      return inserted;
    });
  }

  async backupTo(outputPath) {
    if (this.filename === ":memory:") throw new BusinessError("内存数据库不能备份", "BACKUP_ERROR", 500);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await sqliteBackup(this.db, outputPath);
    this.audit("database", null, "backup", { outputPath });
    return outputPath;
  }
}
