import test from "node:test";
import assert from "node:assert/strict";
import { calculateAmountFen, quantityToMilli, splitPrintColumns, yuanToFen } from "../src/domain.mjs";

test("金额采用定点规则计算", () => {
  assert.equal(quantityToMilli("1.5"), 1500);
  assert.equal(quantityToMilli("4.6"), 4600);
  assert.equal(quantityToMilli("4.678"), 4678);
  assert.throws(() => quantityToMilli("4.6789"), /最多三位小数/);
  assert.equal(yuanToFen("2.50"), 250);
  assert.equal(calculateAmountFen(1500, 250), 375);
});

test("超过10项仍在同一个单据内按左右栏排版", () => {
  const items = Array.from({ length: 17 }, (_, index) => ({ index }));
  const layout = splitPrintColumns(items);
  assert.equal(layout.rows, 9);
  assert.equal(layout.left.length, 9);
  assert.equal(layout.right.length, 8);
  assert.equal(layout.density, "dense");
});
