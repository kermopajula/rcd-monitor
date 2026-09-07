# Pool heater monitor

Pings the pool heater on the local network and alerts via [ntfy](https://ntfy.sh) push
notifications and/or email via [Resend](https://resend.com) when it stops responding. The heater sits
behind an RCD, so once it loses power it stays off until someone resets it: the monitor alerts,
reminds every hour while it stays down, and confirms when it is back.

Runs on the Raspberry Pi under pm2 alongside other services.

## Setup

```bash
yarn
cp .env.example .env   # fill in heaterIp and at least one notification channel
yarn prod              # build, (re)start under pm2 as "pool-heater", pm2 save
```

Give the heater a DHCP reservation in the router so `heaterIp` never changes, and check from the Pi
that it answers pings at all:

```bash
ping -c 3 192.168.1.50
```

For development: `yarn dev` (tsx watch).

## How it works

- Every `checkMinutes` (default 5) the heater is pinged once (system `ping`, 10 s timeout).
- After `failureThreshold` consecutive misses (default 2) an "OFFLINE" alert is sent.
- While it stays down, a "still OFFLINE" reminder with the elapsed time goes out every
  `reminderMinutes` (default 60).
- When it answers again a "back online" alert is sent with the outage duration.
- State is persisted to `state.json`, so restarts keep the outage start time, reminder cadence
  and mute setting.

## Muting (intentional power-off)

```bash
# mute for 8 hours
curl -X POST -H "Authorization: Bearer $apiToken" -H "Content-Type: application/json" \
  -d '{"hours": 8}' http://localhost:3001/mute

# mute until unmuted
curl -X POST -H "Authorization: Bearer $apiToken" http://localhost:3001/mute

# unmute (checks immediately, alerts if still down)
curl -X POST -H "Authorization: Bearer $apiToken" http://localhost:3001/unmute
```

Checks keep running while muted so `/status` stays accurate. The mute is lifted automatically once
the heater comes back online after an outage, so an intentional shutdown cannot leave alerts off
by accident.

## API

| Method | Path      | Description                                              |
| ------ | --------- | -------------------------------------------------------- |
| GET    | `/status` | Current state: status, downSince, downFor, muted, ...    |
| POST   | `/mute`   | Body `{"hours": 8}` or `?hours=8`; omit for indefinite   |
| POST   | `/unmute` | Re-enable alerts                                          |
| POST   | `/test`   | Send a test notification through every configured channel |

All requests need `Authorization: Bearer <apiToken>` when `apiToken` is set in `.env`.
