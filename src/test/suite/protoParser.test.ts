import * as assert from "node:assert";
import test from "node:test";
import { parseProto } from "../../protoParser";

void test("indexes nested symbols and rpc methods", () => {
  const content = [
    'syntax = "proto3";',
    "package demo.billing.v1;",
    "",
    "message Invoice {",
    "  message LineItem {",
    "    string sku = 1;",
    "  }",
    "}",
    "",
    "service BillingService {",
    "  rpc GetInvoice (GetInvoiceRequest) returns (Invoice);",
    "}",
    ""
  ].join("\n");

  const parsed = parseProto("/tmp/demo.proto", content);
  const names = parsed.symbols.map((symbol) => symbol.fqName);

  assert.ok(names.includes("demo.billing.v1.Invoice"));
  assert.ok(names.includes("demo.billing.v1.Invoice.LineItem"));
  assert.ok(names.includes("demo.billing.v1.BillingService"));
  assert.ok(names.includes("demo.billing.v1.BillingService.GetInvoice"));
});

void test("collects imports", () => {
  const content = [
    'syntax = "proto3";',
    "package demo.types.v1;",
    'import "google/protobuf/timestamp.proto";',
    ""
  ].join("\n");

  const parsed = parseProto("/tmp/types.proto", content);
  assert.deepStrictEqual(parsed.imports, ["google/protobuf/timestamp.proto"]);
});

void test("handles rpc option blocks and multiline signatures", () => {
  const content = [
    'syntax = "proto3";',
    "package demo.catalog.v1;",
    "",
    "service CatalogService {",
    "  rpc GetItem (GetItemRequest)",
    "      returns (GetItemResponse) {",
    "    option deprecated = true;",
    "  }",
    "  rpc ListItems (ListItemsRequest) returns (ListItemsResponse);",
    "}",
    ""
  ].join("\n");

  const parsed = parseProto("/tmp/catalog.proto", content);
  const rpcNames = parsed.symbols
    .filter((symbol) => symbol.type === "rpc")
    .map((symbol) => symbol.fqName)
    .sort();

  assert.deepStrictEqual(rpcNames, [
    "demo.catalog.v1.CatalogService.GetItem",
    "demo.catalog.v1.CatalogService.ListItems"
  ]);
});
