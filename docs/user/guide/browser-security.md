# Browser login security

English | [中文](browser-security.zh.md)

## Enable managed sessions

The [HTTPS overlay](../../../apps/cli/config/examples/browser-security.patch.yml) enables revocable browser sessions. Run one Web process per Harness home, behind an HTTPS reverse proxy that preserves Host and supports WebSocket upgrades. From the repository root, start the Web profile with the overlay and your actual hostname:

```sh
pnpm dsh --profile web --patch apps/cli/config/examples/browser-security.patch.yml --no-open --trusted-host dsh.example.com
```

The overlay replaces the Connection row's configuration and preserves the trusted hosts supplied by the Web runtime. It sets Secure cookies, a 30-day absolute lifetime, and a maximum of 100 active sessions. Existing stateless cookies require a fresh login using the startup URL; other application data is unchanged. Managed credentials are stored through the normal credential provider and must be included in private backups.

## Configure models remotely

After signing in, open **Settings → Models** to configure providers. Managed sessions use shared server settings: model configuration, preferences, and onboarding acknowledgement persist across reloads. Provider API keys remain write-only credentials. Remote browsers do not offer **Open configuration file**, which launches a native editor on the server. Every authenticated browser is an administrator, not a separate user account.

## Manage devices

Open **Settings → Login security**. Each login from a fresh browser cookie jar creates a device session. Rename a device to identify it; the browser description is not a verified hardware identity. A copied cookie shares the same session and is revoked with it. Refresh the list to see activity, including connection heartbeats.

**Sign out device** revokes one device. **Sign out other devices** keeps the current session on this authority. **Renew current cookie** replaces only the current cookie; it cannot remotely install a new cookie on another browser. Revoked Gateway connections terminate immediately; already-dispatched unary operations are not rolled back.

**Rotate launch link** invalidates the old startup URL while keeping existing sessions. **Sign out all and rotate link** revokes every authority's sessions. **Rotate global signing key** additionally replaces the signing secret; old keys have no grace period. The two global actions also sign out the current browser and show a new private login link. Save the link before leaving the page.

## Recovery and updates

If a rotation response is lost or no browser remains signed in, restart the Web service and use its newly printed startup URL. Do not publish logs containing that URL. Ordinary restarts retain valid managed sessions; they rotate the launch token. Disabling managed mode restores the separate legacy authentication mode, so it is not a revocation procedure.

Keep custom changes committed in your fork. Fetch the official upstream and merge its default branch into your custom branch, resolve conflicts, and run the authentication and browser regressions before pushing. Deployment then pulls your fork, installs locked dependencies, builds, and restarts only after the build succeeds. Keep the prior commit and private credential backup for rollback; a rollback to stateless authentication changes which cookies are accepted.
