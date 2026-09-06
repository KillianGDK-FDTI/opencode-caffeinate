# opencode-caffeinate

Automatically prevent macOS idle sleep while OpenCode works. No extra terminal,
runtime dependencies, model calls, or permanent power-setting changes.

## Install

Clone this repository, then add its absolute file URL to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-caffeinate/index.js"]
}
```

Merge this entry with existing plugins. Restart OpenCode after installation or
updates. Remove the entry and restart to uninstall. This is a GitHub distribution;
the package is not published to npm.

## Behavior

- Tracks `session.status`: busy and retry prevent sleep; idle releases protection.
- Tracks multiple sessions independently within each OpenCode project instance.
- Pauses protection for sessions awaiting questions or permissions. Other busy
  sessions remain protected. A parent waiting on a blocked subagent may still be
  marked busy by OpenCode; protection is conservatively retained in that case.
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
- A one-minute status check reconciles missed idle events. Successful checks
  renew leases after three minutes, with overlap during process replacement.
- A failed status check does not renew protection. Subsequent activity events
  can still renew it. Status polling cannot detect a hung task reported as busy.
- Four hours of uninterrupted work is the default hard limit. At the limit,
  protection stops until all tracked work becomes idle or waits for user input.
  This deliberately allows sleep even if a task still claims to be busy.

To change the continuous-work limit (seconds, integer from 300 to 2147483):

```json
{
  "plugin": [
    ["file:///absolute/path/to/opencode-caffeinate/index.js", { "maxSeconds": 28800 }]
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

MIT licensed.
