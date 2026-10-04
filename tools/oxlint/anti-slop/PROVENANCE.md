# Anti-slop provenance

Vendored byte-for-byte from [LouisVannobel/projetV0-saas-template](https://github.com/LouisVannobel/projetV0-saas-template/tree/c7a5443333f25d990d80dcdfe3a31a29dfa0ee7b/tools/oxlint/anti-slop), commit `c7a5443333f25d990d80dcdfe3a31a29dfa0ee7b`, directory `tools/oxlint/anti-slop/`.

The upstream MIT license and all plugin sources are retained unchanged. The repository root configuration is adapted only to Sparra's `src` paths. Runtime service-constructor imports are checked under `src`; test/spec constructors remain allowed. The lint command explicitly selects the marketing consumers and shared boundaries changed by this delivery. It does not qualify the entire retained R1 tree.

Canaries use owned temporary files beneath `src`, narrowed unknown boundaries, an invalid chained assertion and a local runtime service-constructor import. No Next.js, React Doctor or starter workflow is imported. Oxlint and its plugin API are exactly pinned to `1.78.0`; TypeScript remains the single normative typecheck.
