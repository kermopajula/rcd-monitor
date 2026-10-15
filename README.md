# RCD monitor

Pings a device on the local network and alerts via [ntfy](https://ntfy.sh) push notifications
and/or email via [Resend](https://resend.com) when it stops responding. Meant for devices that sit
behind an RCD, so once they lose power they stay off until someone resets it: the monitor alerts,
reminds every hour while it stays down, and confirms when it is back. For an intentional shutdown,
[pause the alerts](#pausing-alerts) for a set time.

Runs on the Raspberry Pi under pm2 alongside other services.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in deviceIp, deviceName and at least one notification channel
pnpm prod              # build, (re)start under pm2 as "rcd-monitor", pm2 save
```

Give the device a DHCP reservation in the router so `deviceIp` never changes, and check from the Pi
that it answers pings at all:

```bash
ping -c 3 192.168.1.50
```

For development: `pnpm dev` (tsx watch).

## How it works

- Every `checkMinutes` (default 5) the device is pinged once (system `ping`, 10 s timeout).
- After `failureThreshold` consecutive misses (default 2) an "OFFLINE" alert is sent.
- While it stays down, a "still OFFLINE" reminder with the elapsed time goes out every
  `reminderMinutes` (default 60).
- When it answers again a "back online" alert is sent with the outage duration.
- State is persisted to `state.json`, so restarts keep the outage start time, reminder cadence
  and pause.

## Pausing alerts

Run these in the project folder on the Pi:

```bash
pnpm pause 8h     # no alerts for 8 hours (also 30m, 2d; a bare number means hours)
pnpm resume       # lift the pause early
pnpm status       # current state, including pausedUntil
```

A pause always has an end time, so monitoring cannot be left off by accident. Pausing and resuming
each send a low-priority notification. Checks keep running while paused, so if the device is still
down when the pause ends, the alert goes out right away.

## API

| Method | Path            | Description                                               |
| ------ | --------------- | --------------------------------------------------------- |
| GET    | `/status`       | Current state: status, downSince, downFor, lastError, ... |
| POST   | `/pause?for=8h` | Pause alerts for `30m` / `8h` / `2d`                      |
| POST   | `/resume`       | Lift a pause early and check right away                   |
| POST   | `/test`         | Send a test notification through every configured channel |

All requests need `Authorization: Bearer <apiToken>` when `apiToken` is set in `.env`.
