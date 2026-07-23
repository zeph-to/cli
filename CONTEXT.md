# CONTEXT (glossary) — Zeph CLI/MCP encryption

Glossary only — no implementation detail. Terms for the per-device E2E domain
(design in encl ADR-0007 / ADR-0008, currently **deferred**). Captured during a
grill-with-docs session 2026-06-29.

## Terms

### Machine Device
A single logical device representing one host. Identified by `deviceId =
computeListenerDeviceId()` (deterministic from platform **machine id**; machine id를
못 읽는 예외에서만 hostname fallback — 이때는 `~/.zeph/listener-device-id`에 고정(persist)해
hostname drift가 한 머신을 여러 device로 분열시키지 않게 한다). All Zeph processes on that
host — `zeph notify` (sender), the listener (receiver), and the MCP server (sender) —
share **one** Machine Device identity and **one** Device Keypair. The phone sees one
device per machine, not one per process.

### Config precedence
env (`ZEPH_WS_URL` 등) > config file > built-in default — cli/mcp-server/plugin
3패키지 공통 계약. CLI flag 최상위 tier는 cli 전용(mcp-server는 stdio 서버,
plugin은 hook이라 flag 없음). 우선순위 변경 시 이 절부터 갱신한다.

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

### Listener version stamp
`~/.zeph/listener.version` — the CLI version the *running* daemon booted from,
written next to `listener.pid` by `writeListenerRuntime()` and read by the `zeph cc`
wrapper. `npm i -g`는 디스크의 패키지만 바꾸고 상주 프로세스는 그대로 두므로, 이 스탬프가
"설치본 ≠ 상주본" drift를 감지하는 유일한 신호다. **없으면 = 구버전** (스탬프 도입 이전
빌드라는 뜻). 두 파일은 `listener-process.ts` 한 곳에서만 쓰고 지운다 — listener와 wrapper가
각자 경로를 재구현하면 drift 판정이 갈린다.

### Agent key whitelist (3-site 동기)
`ALLOWED_KEYS` (listener.ts, phone→pane 키 주입) is mirrored in two other repos'
files that MUST change together, else a new key is rejected before it reaches the
daemon: zeph `pushes.ts ALLOWED_AGENT_KEYS` (server gate) and the zeph web key row.
Add a key → update all three.
