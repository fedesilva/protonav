import * as assert from "node:assert";
import test from "node:test";
import { resolveMemberNavigation } from "../../memberNavigation/resolver";
import { createSourceDocument } from "../../memberNavigation/shared";
import {
  ProtoMemberLookup,
  ResolvedProtoFieldCandidate,
  ResolvedProtoMessageCandidate
} from "../../memberNavigation/types";

void test("resolves Go field access from a typed parameter", () => {
  const source = [
    "func handle(msg *samplepb.Order) {",
    "    _ = msg.CustomerId",
    "}",
    ""
  ].join("\n");

  const resolution = resolveMemberNavigation(
    createSourceDocument(source, "go"),
    positionFor(source, "CustomerId"),
    createLookup(
      {
        "samplepb.Order": [{ fqName: "demo.orders.v1.Order" }]
      },
      {
        "demo.orders.v1.Order.customer_id": [field("demo.orders.v1.Order", "customer_id")]
      }
    )
  );

  assert.ok(resolution);
  assert.deepStrictEqual(resolution.receiverTypeTokens, ["samplepb.Order"]);
  assert.deepStrictEqual(resolution.fieldNameCandidates, ["customer_id"]);
  assert.deepStrictEqual(resolution.matches.map((match) => match.key), ["demo.orders.v1.Order.customer_id"]);
});

void test("resolves Go getter access from a composite literal assignment", () => {
  const source = [
    "func handle() {",
    "    msg := &samplepb.Order{}",
    "    _ = msg.GetCustomerId()",
    "}",
    ""
  ].join("\n");

  const resolution = resolveMemberNavigation(
    createSourceDocument(source, "go"),
    positionFor(source, "GetCustomerId"),
    createLookup(
      {
        "samplepb.Order": [{ fqName: "demo.orders.v1.Order" }]
      },
      {
        "demo.orders.v1.Order.customer_id": [field("demo.orders.v1.Order", "customer_id")]
      }
    )
  );

  assert.ok(resolution);
  assert.deepStrictEqual(resolution.fieldNameCandidates, ["customer_id"]);
});

void test("rejects Go runtime helper members", () => {
  const source = [
    "func handle(msg *samplepb.Order) {",
    "    _ = msg.ProtoReflect()",
    "}",
    ""
  ].join("\n");

  const resolution = resolveMemberNavigation(
    createSourceDocument(source, "go"),
    positionFor(source, "ProtoReflect"),
    createLookup({}, {})
  );

  assert.strictEqual(resolution, undefined);
});

void test("resolves Python attribute access from constructor assignment", () => {
  const source = [
    "def handle() -> None:",
    "    msg = sample_pb2.Order()",
    "    value = msg.customer_id",
    ""
  ].join("\n");

  const resolution = resolveMemberNavigation(
    createSourceDocument(source, "python"),
    positionFor(source, "customer_id"),
    createLookup(
      {
        "sample_pb2.Order": [{ fqName: "demo.orders.v1.Order" }]
      },
      {
        "demo.orders.v1.Order.customer_id": [field("demo.orders.v1.Order", "customer_id")]
      }
    )
  );

  assert.ok(resolution);
  assert.deepStrictEqual(resolution.receiverTypeTokens, ["sample_pb2.Order"]);
});

void test("falls back when constrained field lookup stays ambiguous", () => {
  const source = [
    "func handle(msg *samplepb.Order) {",
    "    _ = msg.CustomerId",
    "}",
    ""
  ].join("\n");

  const resolution = resolveMemberNavigation(
    createSourceDocument(source, "go"),
    positionFor(source, "CustomerId"),
    createLookup(
      {
        "samplepb.Order": [{ fqName: "demo.orders.v1.Order" }, { fqName: "demo.archive.v1.Order" }]
      },
      {
        "demo.orders.v1.Order.customer_id": [field("demo.orders.v1.Order", "customer_id")],
        "demo.archive.v1.Order.customer_id": [field("demo.archive.v1.Order", "customer_id")]
      }
    )
  );

  assert.strictEqual(resolution, undefined);
});

void test("falls back for unsupported Python method calls", () => {
  const source = [
    "def handle(msg: sample_pb2.Order) -> None:",
    "    payload = msg.SerializeToString()",
    ""
  ].join("\n");

  const resolution = resolveMemberNavigation(
    createSourceDocument(source, "python"),
    positionFor(source, "SerializeToString"),
    createLookup({}, {})
  );

  assert.strictEqual(resolution, undefined);
});

function createLookup(
  messagesByTypeToken: Record<string, ResolvedProtoMessageCandidate[]>,
  fieldsByKey: Record<string, ResolvedProtoFieldCandidate[]>
): ProtoMemberLookup {
  return {
    findMessageTypes: (typeToken) => messagesByTypeToken[typeToken] ?? [],
    findFields: (messageFqNames, fieldNames) =>
      messageFqNames.flatMap((messageFqName) =>
        fieldNames.flatMap((fieldName) => fieldsByKey[`${messageFqName}.${fieldName}`] ?? [])
      )
  };
}

function field(messageFqName: string, fieldName: string): ResolvedProtoFieldCandidate {
  return {
    key: `${messageFqName}.${fieldName}`,
    messageFqName,
    fieldName
  };
}

function positionFor(source: string, token: string): { line: number; character: number } {
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const charIndex = lines[lineIndex].indexOf(token);
    if (charIndex >= 0) {
      return {
        line: lineIndex,
        character: charIndex + Math.floor(token.length / 2)
      };
    }
  }

  throw new Error(`Token not found: ${token}`);
}
