export class BusinessError extends Error {
  constructor(message, code = "BUSINESS_ERROR", status = 400, details = null) {
    super(message);
    this.name = "BusinessError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assertText(value, label, maxLength = 200) {
  const text = String(value ?? "").trim();
  if (!text) throw new BusinessError(`${label}不能为空`, "VALIDATION_ERROR");
  if (text.length > maxLength) throw new BusinessError(`${label}不能超过${maxLength}个字`, "VALIDATION_ERROR");
  return text;
}

export function optionalText(value, maxLength = 500) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new BusinessError(`内容不能超过${maxLength}个字`, "VALIDATION_ERROR");
  return text || null;
}

export function normalizeDate(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BusinessError("日期格式必须为YYYY-MM-DD", "VALIDATION_ERROR");
  }
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new BusinessError("日期无效", "VALIDATION_ERROR");
  }
  return text;
}

export function normalizeMonth(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
    throw new BusinessError("月份格式必须为YYYY-MM", "VALIDATION_ERROR");
  }
  return text;
}

export function previousDate(dateText) {
  const date = new Date(`${normalizeDate(dateText)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function yuanToFen(value, label = "金额") {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new BusinessError(`${label}必须是最多两位小数的非负数字`, "VALIDATION_ERROR");
  }
  const [whole, decimal = ""] = text.split(".");
  const fen = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(fen)) throw new BusinessError(`${label}过大`, "VALIDATION_ERROR");
  return fen;
}

export function fenToYuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

export function quantityToMilli(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text)) {
    throw new BusinessError("数量必须是最多三位小数的正数", "VALIDATION_ERROR");
  }
  const [whole, decimal = ""] = text.split(".");
  const quantity = Number(whole) * 1000 + Number(decimal.padEnd(3, "0"));
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new BusinessError("数量必须大于0", "VALIDATION_ERROR");
  }
  return quantity;
}

export function milliToQuantity(quantityMilli) {
  const value = Number(quantityMilli || 0) / 1000;
  return value.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function calculateAmountFen(quantityMilli, unitPriceFen) {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) {
    throw new BusinessError("数量无效", "VALIDATION_ERROR");
  }
  if (!Number.isSafeInteger(unitPriceFen) || unitPriceFen < 0) {
    throw new BusinessError("单价无效", "VALIDATION_ERROR");
  }
  return Math.round((quantityMilli * unitPriceFen) / 1000);
}

export function formatOrderNumber(date, sequence) {
  return `${normalizeDate(date).replaceAll("-", "")}-${String(sequence).padStart(4, "0")}`;
}

export function monthBounds(month) {
  const normalized = normalizeMonth(month);
  const [year, monthNumber] = normalized.split("-").map(Number);
  const start = `${normalized}-01`;
  const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return { start, next };
}

export function splitPrintColumns(items) {
  const rows = Math.max(5, Math.ceil(items.length / 2));
  return {
    rows,
    left: items.slice(0, rows),
    right: items.slice(rows),
    density: items.length <= 10 ? "normal" : items.length <= 14 ? "compact" : items.length <= 20 ? "dense" : "ultra",
  };
}
