# CONTEXT (glossary) — Zeph CLI/MCP encryption

Glossary only — no implementation detail. Terms for the per-device E2E domain
(design in encl ADR-0007 / ADR-0008, currently **deferred**). Captured during a
grill-with-docs session 2026-06-29.

## Terms

### Machine Device
A single logical device representing one host. Identified by `deviceId =
computeListenerDeviceId()` (deterministic from hostname). All Zeph processes on that
host — `zeph notify` (sender), the listener (receiver), and the MCP server (sender) —
share **one** Machine Device identity and **one** Device Keypair. The phone sees one
device per machine, not one per process.

### Device Keypair
The ECDH P-256 key material owned by a Machine Device. The **private** key never
leaves the host. The **public** key is registered with the server so other devices
can encrypt to this one. Distinct from the obsolete per-user keypair (removed).

### Sender / Recipient
A **Sender** is the process producing a push (CLI notify, MCP tool). A **Recipient**
is a device that should be able to read it. A Sender encrypts for every Recipient
that has a per-device public key, excluding its own Machine Device.

### deviceKeyMap
The per-recipient wrapped-key bundle that rides with an encrypted push:
`{ deviceId → the message key wrapped for that device }`. Opaque to the server.

### encryptionEnabled
The single authoritative signal a client reads (from the server) to decide whether to
encrypt. True implies the user is PRO and has opted in. Clients do not inspect the
plan directly.

### Eligible Recipient
A Recipient that currently has a per-device public key registered. Encryption targets
only Eligible Recipients; if there are none, the Sender falls back to plaintext.

### Passive vs Active operator (threat-model term)
"Operator can't read" holds against a **passive** operator (won't tamper — covers
DB leak, subpoena, honest-but-curious). It does **not** yet hold against an **active**
operator that substitutes public keys (MITM); that needs out-of-band device
verification (a later phase).
