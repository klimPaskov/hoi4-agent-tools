# ADR 0001: TypeScript on Node.js

- Status: accepted
- Date: 2026-07-10

## Decision

Implement one strict TypeScript package targeting Node.js 22 and 24. Source and internal services use typed discriminated unions and Zod at every untrusted boundary. The compiled package is ESM.

## Rationale

The production MCP SDK is first-class in TypeScript, Node has portable binary and filesystem primitives, and the selected image/font libraries have maintained Node bindings. A single runtime avoids transport/domain duplication. Node 22 is the minimum because the pinned official Inspector requires a recent Node 22 release and Node 22 remains an LTS baseline.

## Consequences

The server cannot claim operating-system filesystem atomicity across several files. It implements durable, recoverable logical transactions and documents that boundary. Native image dependencies are installed through published platform packages and verified during clean installation.
