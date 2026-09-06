# opencode-caffeinate

Automatically prevent macOS idle sleep while OpenCode works. No extra terminal,
runtime dependencies, model calls, or permanent power-setting changes.

## Install

Clone this repository, then add its absolute file URL to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-caffeinate/index.ts"]
}
```

Merge this entry with existing plugins. Restart OpenCode after installation or
updates. Remove the entry and restart to uninstall. OpenCode loads TypeScript
directly: no build or dependency installation is needed to use the plugin.
The package is marked private to prevent accidental npm publication.

## Behavior

- Tracks `session.status`: busy and retry prevent sleep; idle releases protection.
- Tracks multiple sessions independently within each OpenCode project instance.
- Correlates questions and permissions with individual tool calls. Other tools
  running in the same session remain protected, including pending calls.
- Follows task tools' child-session links: a parent waiting on a blocked child
  can pause, without interrupting sibling tools or background child sessions.
- Missing tool correlation or child state is handled conservatively: known
  running tools remain protected rather than assuming they are blocked.
- Leaves screen sleep, screen locking, lid-close sleep, and manual sleep alone.
- Works on battery and AC power. Does nothing on non-macOS hosts.
- Runs on the OpenCode server host, not a remotely connected client computer.

Event handlers schedule process creation outside the synchronous event callback.
No hook waits for the lifetime of `caffeinate`. Local process startup still has a
small cost; this is not a claim of literally zero overhead.

## Safety

Each project instance owns its own child processes and never kills unrelated
`caffeinate` processes. Independent OpenCode instances can each hold an assertion.

Protection uses `/usr/bin/caffeinate -i -t 300 -w <opencode-pid>`:

- Normal completion and plugin disposal terminate owned children.
- The native PID watcher releases protection when the OpenCode process exits,
  including abrupt termination.
- Each native lease expires within five minutes if the plugin freezes.
- A one-minute status check reconciles missed idle events. Two matching snapshots
  without intervening activity events are required before overriding event state,
  because OpenCode publishes events before updating its status map. Successful
  confirmed checks renew leases after three minutes.
- Status requests have an explicit five-second deadline, including when a local
  transport ignores cancellation. Late results cannot overwrite current state.
- A failed status check does not renew protection. Subsequent activity events
  can still renew it. Status polling cannot detect a hung task reported as busy.
- Four hours of uninterrupted work is the default hard limit. At the limit,
  protection stops until all tracked work becomes idle or waits for user input.
  This deliberately allows sleep even if a task still claims to be busy.

To change the continuous-work limit (seconds, integer from 300 to 2147483):

```json
{
  "plugin": [
    ["file:///absolute/path/to/opencode-caffeinate/index.ts", { "maxSeconds": 28800 }]
  ]
}
```

There is no battery-percentage cutoff. Keep the lid open and ensure enough charge
for unattended work. Sleep prevention is not a guarantee against shutdown,
critical-battery sleep, network interruptions, or operating-system overrides.

## Compatibility And Inspection

Targets OpenCode 1.18.29's server plugin API, including the `dispose` hook and
`client.session.status`. Earlier versions are not verified.

Inspect active power assertions with `pmset -g assertions`. The process named
`caffeinate` should hold `PreventUserIdleSystemSleep` during work, and release it
after idle. Warnings use OpenCode's application log, never stdout.

## Development

The source uses strict TypeScript and type-only imports from the official OpenCode
SDK. TypeScript and SDK packages are development dependencies only; none are
imported at runtime. Runtime validation of the single numeric option is explicit,
so a schema library would add no useful complexity reduction.

Use Node.js 24.15+ for development (the SDK's transitive development dependencies
require a recent Node release). The tests use Node's built-in test runner and
mocking APIs; no third-party test framework is required.

```sh
npm ci
npm run typecheck
npm test
```

Tests cover parallel tools, correlated waits, parent/child activity, error cleanup,
late events, lease renewal, stale snapshots, timeouts, disposal, and option bounds.
On macOS, they also exercise real power assertions, native expiry, and owner death.
Some test APIs emit experimental warnings on Node 22.

With OpenCode installed, run the isolated integration test:

```sh
npm run test:opencode
```

It uses a temporary home and config, runs a local shell operation without calling
a model, then stops its server and removes its temporary files. Set `OPENCODE_BIN`
to select a particular OpenCode executable. Your personal config is not loaded.

MIT licensed.
