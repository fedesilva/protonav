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

void test("indexes message fields including map and oneof members", () => {
  const content = [
    'syntax = "proto3";',
    "package demo.orders.v1;",
    "",
    "message Order {",
    "  string id = 1;",
    "  map<string, Item> items = 2;",
    "  oneof payment_method {",
    "    string card_last4 = 3;",
    "    bytes token = 4;",
    "  }",
    "",
    "  message Item {",
    "    optional string sku = 1;",
    "  }",
    "}",
    "",
    "enum Status {",
    "  STATUS_UNSPECIFIED = 0;",
    "}",
    ""
  ].join("\n");

  const parsed = parseProto("/tmp/order.proto", content);
  const fields = parsed.symbols
    .filter((symbol) => symbol.type === "field")
    .map((symbol) => ({
      fqName: symbol.fqName,
      ownerFqName: symbol.ownerFqName,
      scopePath: symbol.scopePath
    }))
    .sort((left, right) => left.fqName.localeCompare(right.fqName));

  assert.deepStrictEqual(fields, [
    {
      fqName: "demo.orders.v1.Order.card_last4",
      ownerFqName: "demo.orders.v1.Order",
      scopePath: ["Order"]
    },
    {
      fqName: "demo.orders.v1.Order.id",
      ownerFqName: "demo.orders.v1.Order",
      scopePath: ["Order"]
    },
    {
      fqName: "demo.orders.v1.Order.Item.sku",
      ownerFqName: "demo.orders.v1.Order.Item",
      scopePath: ["Order", "Item"]
    },
    {
      fqName: "demo.orders.v1.Order.items",
      ownerFqName: "demo.orders.v1.Order",
      scopePath: ["Order"]
    },
    {
      fqName: "demo.orders.v1.Order.token",
      ownerFqName: "demo.orders.v1.Order",
      scopePath: ["Order"]
    }
  ]);
});
