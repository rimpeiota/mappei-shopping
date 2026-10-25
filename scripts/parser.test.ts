import assert from "node:assert/strict";
import test from "node:test";
// Node 24 runs the source directly. A dynamic URL avoids a TypeScript config change.
const { parseShoppingText, validateParsedItems } = await import(new URL("../lib/server-parser.ts", import.meta.url).href) as typeof import("../lib/server-parser");

type ExpectedItem = [string, number, string];
const examples: Array<[string, ExpectedItem[]]> = [
  ["牛乳2本と卵1パック", [["牛乳", 2, "本"], ["卵", 1, "パック"]]],
  ["スーパーで牛乳２本、卵一パックを買ってきて", [["牛乳", 2, "本"], ["卵", 1, "パック"]]],
  ["2本の牛乳\n洗剤1袋", [["牛乳", 2, "本"], ["洗剤", 1, "袋"]]],
  ["牛乳を2本と卵を1パック", [["牛乳", 2, "本"], ["卵", 1, "パック"]]],
  ["おっとっと1箱、さといも2袋、とろけるチーズ1袋", [["おっとっと", 1, "箱"], ["さといも", 2, "袋"], ["とろけるチーズ", 1, "袋"]]],
  ["米2.5kg、牛乳500ml", [["米", 2.5, "kg"], ["牛乳", 500, "mL"]]],
  ["iPhone 16、USBケーブル", [["iPhone 16", 1, "個"], ["USBケーブル", 1, "個"]]],
  ["牛乳1本 @スーパー", [["牛乳", 1, "本"]]],
  ["", []],
  ["牛乳0本", []],
];

for (const [input, expected] of examples) {
  test(`parse: ${input || "empty input"}`, () => {
    assert.deepEqual(parseShoppingText(input).map(({ name, quantity, unit }) => [name, quantity, unit]), expected);
  });
}

test("store prefix is preserved", () => {
  assert.equal(parseShoppingText("スーパーで牛乳2本")[0].store, "スーパー");
});
test("AI output with a negative quantity is rejected", () => {
  assert.equal(validateParsedItems([{ name: "x", quantity: -1, unit: "個", category: "その他" }]), null);
});
test("AI output with an unknown category is rejected", () => {
  assert.equal(validateParsedItems([{ name: "x", quantity: 1, unit: "個", category: "hacked" }]), null);
});
test("an empty AI item list is rejected", () => {
  assert.equal(validateParsedItems([]), null);
});
test("a valid parsed item passes AI result validation", () => {
  assert.equal(validateParsedItems(parseShoppingText("牛乳2本"))?.length, 1);
});
