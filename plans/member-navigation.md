# Proto Member Navigation

## Summary

ProtoNav already resolves proto type names well, but member navigation can still land in generated language bindings instead of the originating `.proto` field definition. This feature adds language-aware member resolution so that clicking a proto-backed member in supported languages resolves to the field declared in the source proto.

V1 supports Go and Python. The implementation should be modular so additional languages can be added by introducing new translators rather than rewriting the core definition flow.

## Goals

- Route supported proto-backed member clicks to the corresponding `.proto` field definition.
- Preserve current type-name navigation behavior.
- Keep the language-specific logic isolated behind a small translator interface.
- Support proto fields declared directly on messages and fields declared inside `oneof`.
- Avoid overriding native editor navigation unless ProtoNav has a high-confidence proto match.

## Non-Goals

- No support in v1 for languages other than Go and Python.
- No attempt to reinterpret runtime helper APIs as proto fields.
- No support in v1 for string-based field APIs such as reflection helpers that take field names as strings.
- No attempt to infer types across arbitrary control flow, chained return values, or whole-program analysis.

## User-Facing Behavior

- Clicking a proto message type should keep the current behavior and resolve to the proto message definition.
- Clicking a supported member on a value known to be a proto message should resolve to the matching field in the proto file.
- If ProtoNav cannot confidently infer the receiver type or field mapping, it should return no result and allow the native language provider to handle navigation.

## Scope

### Supported Languages

- Go
- Python

### Supported Member Forms

- Go field-like member access: `receiver.FieldName`
- Go getter-style member access: `receiver.GetFieldName()`
- Python attribute access: `receiver.field_name`

### Excluded Member Forms

- Go helper/runtime methods such as `Reset`, `String`, `ProtoReflect`, `Descriptor`, and legacy `XXX_*` methods
- Python helper/runtime members such as `SerializeToString`, `CopyFrom`, `HasField`, `ClearField`, `WhichOneof`, and `DESCRIPTOR`
- Reflection APIs that identify fields by string
- Dynamic attribute access patterns

## Design Overview

### 1. Core Resolver Flow

Replace the current token-only definition path with a staged resolver:

1. Detect whether the cursor is on a supported member expression for the current language.
2. If so, ask the language translator to infer candidate proto message types for the receiver.
3. Normalize the clicked member into candidate proto field names.
4. Query the proto index for fields that belong to the inferred message type(s).
5. Return only high-confidence field matches.
6. If that process yields no confident result, fall back to the existing bare-token proto lookup.
7. If ProtoNav still has no answer, return `undefined` and let the native language provider handle the request.

The member-navigation stage must be additive. It should not weaken existing type-name navigation.

### 2. Translator Architecture

Add a new internal `memberNavigation` module with:

- a translator registry keyed by language id
- a shared translator contract
- one Go translator
- one Python translator
- a core resolver that orchestrates translators and proto index lookups

The translator contract should cover three responsibilities:

- determine whether the cursor is on a supported member expression
- infer candidate receiver message types
- normalize the clicked member into candidate proto field names

The core resolver should remain language-agnostic and operate on translator outputs rather than raw source text heuristics.

## Proto Model And Index Changes

### Field Symbols

Extend the proto symbol model to include fields as first-class indexed symbols.

- Add `field` to `ProtoSymbolType`.
- Parse fields declared inside messages.
- Parse fields declared inside `oneof`.
- Keep field ancestry so each field is attached to its containing message.
- Give fields stable ids and ranges like existing symbols.
- Use fully qualified names of the form `package.Message.field_name`.

### Surfacing

Fields should surface everywhere in v1:

- `.proto` document symbols
- workspace symbol search
- the quick-pick symbol finder
- proto definition lookup

Because field names are often common, ranking and ambiguity protections must be stricter for fields than for message-like symbols.

### Ranking And Ambiguity

- Message, enum, service, and RPC symbols should continue to outrank fields in generic search results.
- Qualified or translator-derived field matches should outrank generic short-name field matches.
- Bare-token field lookups should be rejected when the result set is too ambiguous.
- Member-navigation hits should only return results when both the receiver type and the field name are confidently resolved.

## Proto Parsing Requirements

The parser should add field symbol extraction without regressing current symbol parsing.

V1 should parse:

- standard scalar and message-typed fields
- `optional`, `required`, and `repeated` fields
- `map<key, value>` fields
- fields declared inside `oneof`

V1 should not treat these as field symbols:

- enum values
- service methods beyond existing RPC support
- extension declarations
- generated/runtime-only language members

If a field is declared inside a `oneof`, it should resolve as a field whose parent message is the containing message, not as a separate top-level navigable type.

## Go Translator Spec

### Detection

Support member navigation only when the cursor is on:

- the member name in `receiver.FieldName`
- the member name in `receiver.GetFieldName()`

Ignore unsupported call shapes and helper/runtime methods.

### Receiver Type Inference

The Go translator should infer receiver message types from local, high-confidence cues:

- typed function parameters
- typed local variable declarations
- explicit `var` declarations
- receiver declarations on methods
- composite literal assignments
- direct same-file assignments whose declared type is obvious from the syntax

The inferred receiver type should be normalized to the proto message symbol name, including handling package-qualified references.

If implementation needs secondary help from the editor, it may use VS Code definition/type-definition commands as a bounded fallback, but that flow must be protected against recursion and should only be used when local syntax inspection is insufficient.

### Member Name Normalization

Convert supported Go member forms into proto field-name candidates:

- `FieldName` -> `field_name`
- `GetFieldName` -> `field_name`

The translator should reject names that map to known runtime/helper APIs.

## Python Translator Spec

### Detection

Support member navigation only when the cursor is on the attribute name in:

- `receiver.field_name`

Do not support dynamic lookups or string-based helpers.

### Receiver Type Inference

The Python translator should infer receiver message types from local, high-confidence cues:

- parameter annotations
- local variable annotations
- constructor assignments such as `msg = sample_pb2.Order()`
- imported module aliases used by those annotations or constructors

If the translator cannot map the receiver to a proto message symbol confidently, it should return no result.

### Member Name Normalization

Use the clicked attribute name directly as the primary proto field candidate.

The translator should reject known helper/runtime members rather than trying to reinterpret them.

## Extension Integration

Update the definition provider flow so ProtoNav resolves definitions in this order:

1. language-aware member navigation
2. existing token-based proto symbol lookup
3. native VS Code language provider fallback

No new configuration is needed in v1. The existing `protonav.preferProtoDefinitions` flag should continue to gate ProtoNav definition overrides.

## Testing Plan

### Parser Tests

- fields on messages
- nested message fields
- `map` fields
- `oneof` fields
- regression coverage for existing message/enum/service/RPC parsing

### Index Tests

- field symbol indexing
- field parent/container metadata
- field lookup constrained by message type
- field ranking relative to other symbol kinds
- ambiguity cutoffs for generic field-name lookups

### Translator Tests

Go:

- struct/member access detection
- getter detection
- receiver type inference from parameters and locals
- helper/runtime method rejection
- Go member-name to proto-field normalization

Python:

- attribute access detection
- receiver inference from annotations and constructor assignments
- import alias handling
- helper/runtime member rejection

### Resolver Tests

- high-confidence member clicks resolve to proto fields
- type-name clicks preserve current behavior
- ambiguous receiver type falls back
- ambiguous field-name result sets fall back
- unsupported member forms fall back

## Acceptance Criteria

- Supported Go member clicks on proto-backed fields navigate to the field declaration in the `.proto` file.
- Supported Python member clicks on proto-backed fields navigate to the field declaration in the `.proto` file.
- Type-name navigation continues to work as it does today.
- Helper/runtime API members do not get remapped to proto fields.
- Ambiguous or low-confidence cases fall back to native editor behavior.
- The implementation is structured so new language translators can be added without changing the core resolver contract.

## Assumptions And Defaults

- Correctness is more important than aggressiveness.
- Field symbols are intentionally first-class in v1, even if that requires tighter ranking rules.
- `oneof` members count as supported fields in v1.
- No new settings are required for the first iteration.
- This is a feature-level change and should trigger a `MINOR` version bump when the implementation is eventually shipped.
