# Agent Note: Managed browser sessions

Status: implemented

English | [中文](2026-09-17-managed-browser-sessions.zh.md)

## Problem

A reverse-proxied, single-owner Web deployment needs to list browser sessions, revoke copied credentials, and rotate login links without restarting the agent. Stateless cookies cannot identify or revoke one session.

## Decision

Connection offers opt-in `browserSessionManagement`; its default remains false. The managed owner stores a signing secret, key identifier, and bounded session list in the separate `client-connection/managed-browser-sessions` credential record. The v2 cookie contains a random session identifier and HMAC; authentication also requires a live, authority-matching server record. Enabling managed mode rejects legacy cookies and requires a fresh launch-token exchange. `secureCookie` adds Secure for HTTPS deployments; the proxy must preserve Host.

Login and mutations serialize durable writes before publishing cookies or revocations. Authenticated JSON mutations require an exact same-origin Origin, including scheme. The settings-general plugin adds a localized Login security section only when the Host advertises managed mode. Connection's exact Fetch route owns the cookie response; generated RPC cannot set browser cookies. Lists and targeted operations are authority-scoped. Global logout and signing-key rotation intentionally revoke all authorities and also rotate the process launch token, returning one recovery URL. Current-cookie rotation replaces only the caller's session; another browser must log in again after revocation.

Gateway revalidates upgraded connections immediately on revocation, before incoming and outgoing stream messages, and on its existing heartbeat. Already-dispatched unary operations are not rolled back. Last activity includes heartbeats, is tracked in memory, and is checkpointed during subsequent session mutations. Sessions retain an absolute expiry and are bounded by `maxBrowserSessions`, default 100. At capacity, token login is refused until a session expires or is revoked.

Managed login also enables the shared Host settings mirror in remote browsers. The existing authenticated HTML flag selects persistence for models, preferences, and onboarding; Connection remains the authentication authority. `isLoopback` retains its actual meaning, so native configuration-file actions remain local-only. A second settings opt-in would leave an authenticated administrator with an unusable Models page unless both switches were coordinated.

## Verification

Owner-local tests cover independent device revocation, restart persistence, failed writes, concurrent login commits, authority isolation, Origin checks, expiry, capacity, and independent cookie/token/key rotation. The real Loader HTTP composition exercises token exchange, authenticated management, revoked index/API access, and route disposal. The Web scenario boots the shipped plugins with an opt-in overlay and checks localized controls, renaming, live socket cutoff, cookie renewal, and a usable recovery link after global rotation.

The non-loopback Web regression uses a trusted test hostname with Chromium-only loopback routing. It saves a provider through the Models UI, checks the isolated settings file, reloads the saved row, verifies that no native configuration-file action appears, and checks that logout blocks settings API access. Unit coverage retains the unmanaged remote memory-only policy.

## Alternatives considered

Purely external management cannot revoke cookies held by Connection's private verifier. The implementation extends the existing Connection and settings plugins, keeping opt-in configuration and avoiding a new package graph. A distributed session store is deferred: managed mode supports one active Web process per Harness home. Multiple simultaneous owners would require shared invalidation and transaction coordination. Graceful old-key acceptance is also deferred; global key rotation invalidates immediately.

## Consequences

Every authenticated browser remains an administrator of the complete Host API. Device names are user labels, not hardware identity; copied cookies share one session. An ordinary logout or targeted revocation does not revoke a known launch token, so operators rotate the launch link when it may have leaked. If a rotation response is lost, restarting the service prints a fresh launch URL. Legacy records remain separate; deliberately disabling managed mode restores legacy authentication behavior.

This opt-in deployment mode partially supersedes the logout and reverse-proxy deferrals in [browser launch-token authentication](../architecture/2026-08-24-browser-token-authentication.md). That note remains active for the default stateless mode; no note is archived.
