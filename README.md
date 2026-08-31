<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/master/logos/homebridge-color-round-stylized.png" height="140" alt="Homebridge"></a>
</p>

# homebridge-garage-door-relay

An event-driven Homebridge accessory for a garage door or gate controlled by an HTTP relay, such as a Shelly 1. It supports open and closed endpoint sensors, simulated missing sensors, automatic-closing doors, state persistence, and sensor updates through a local webhook.

## Homebridge 2 compatibility

Version 2 is a strict TypeScript/ESM implementation built for Homebridge 2 and current supported Node.js releases. It follows the current [Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template) and [Homebridge 2 migration guidance](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0).

Existing installations do **not** need to change their Homebridge configuration:

- The npm plugin name remains `homebridge-garage-door-relay`.
- The registered accessory name remains `GarageDoorOpener`.
- The accessory remains a static accessory, avoiding a cache or platform migration.
- The default serial remains `gd-<name slug>`.
- Persisted state remains in `garage-door-state-<name slug>.json`.
- Existing option names, defaults, relay calls, and webhook URLs remain supported.

Keep the configured `name` and any explicit `serial` unchanged during the upgrade so Homebridge retains the same accessory identity.

### Requirements

- Homebridge `1.8.x` or `2.x`
- Node.js `22.12+`, `24.x`, or `26.x`

Homebridge 1.8 remains supported so the plugin can be upgraded before Homebridge itself.

## Installation

Install from the Homebridge UI by searching for `homebridge-garage-door-relay`, or install the published package globally:

```sh
npm install -g homebridge-garage-door-relay
```

## Configuration

Add an entry to the `accessories` array in Homebridge's `config.json`:

```json
{
  "accessory": "GarageDoorOpener",
  "name": "Garage Door",
  "http_method": "GET",
  "openURL": "http://192.0.2.10/relay/0?turn=on",
  "closeURL": "http://192.0.2.10/relay/0?turn=on",
  "openTime": 10,
  "closeTime": 10,
  "autoClose": false,
  "autoCloseDelay": 20,
  "hasClosedSensor": true,
  "hasOpenSensor": false,
  "webhookPort": 51828,
  "timeout": 3000,
  "manufacturer": "Shelly",
  "model": "Shelly 1",
  "debug": false
}
```

### Required options

| Option | Description |
| --- | --- |
| `accessory` | Must remain `GarageDoorOpener`. |
| `name` | Accessory name shown in Homebridge and the Home app. |
| `openURL` | HTTP or HTTPS URL that triggers opening. |
| `closeURL` | URL that triggers closing. Required unless `autoClose` is enabled. |
| `hasClosedSensor` | Whether a webhook reports the fully closed endpoint. |
| `hasOpenSensor` | Whether a webhook reports the fully open endpoint. |

When `autoClose` is disabled, at least one endpoint sensor must be enabled. A missing opposite endpoint is simulated after `openTime` or `closeTime`.

### Optional settings

| Option | Default | Description |
| --- | ---: | --- |
| `http_method` | `GET` | Relay request method: `GET` or `POST`. |
| `openTime` | `10` | Expected opening time in seconds. |
| `closeTime` | `10` | Expected closing time in seconds. |
| `autoClose` | `false` | Simulate a door that closes automatically without a separate close request. Cannot be combined with sensors or a webhook port. |
| `autoCloseDelay` | `20` | Seconds after the open relay request before automatic closing begins. |
| `timeout` | `3000` | Relay HTTP timeout in milliseconds. |
| `username` / `password` | — | HTTP Basic authentication credentials. Both must be provided to enable authentication. |
| `verifyTls` | `false` | Verify HTTPS certificates. The compatibility default remains off for existing local devices with self-signed certificates; enable it whenever the relay has a trusted certificate. |
| `webhookPort` | — | Local port on which sensor webhooks are accepted. Each accessory needs a unique port; leave empty or use `0` to disable it. |
| `manufacturer` | `simonp2014` | HomeKit manufacturer metadata. |
| `model` | `garage-door-relay` | HomeKit model metadata. |
| `serial` | `gd-<name slug>` | HomeKit serial metadata. Keep this stable after pairing. |
| `firmware` | plugin version | HomeKit firmware metadata. |
| `debug` | `false` | Enable plugin debug messages. |

A completed HTTP response retains the historical behavior of counting as a successful relay trigger, regardless of its HTTP status code. GET redirects are followed for up to five hops. Network and timeout failures are reported to Homebridge.

## Sensor webhooks

Configure `webhookPort`, then send endpoint changes to the root path on the Homebridge host:

```text
http://<homebridge-host>:<webhookPort>/?closed=true
http://<homebridge-host>:<webhookPort>/?closed=false
http://<homebridge-host>:<webhookPort>/?open=true
http://<homebridge-host>:<webhookPort>/?open=false
```

- `closed=true`: the door reached fully closed.
- `closed=false`: the door left the fully closed position and is opening.
- `open=true`: the door reached fully open.
- `open=false`: the door left the fully open position and is closing.

Only send events for sensors enabled in the accessory configuration. Add `background=true` for a periodic reconciliation update; background events are ignored while an operation is active.

The webhook is intentionally local and unauthenticated for compatibility. Restrict the selected port to a trusted LAN and do not expose it to the internet.

## State persistence and identity

The current state is stored under Homebridge's persist directory as:

```text
garage-door-state-<lowercase-name-with-nonalphanumerics-as-dashes>.json
```

Changing `name` changes this path and the default serial. If a rename is necessary, set an explicit stable `serial` first and move the state file while Homebridge is stopped.

## Development

```sh
npm install
npm run lint
npm test
npm pack --dry-run
```

`npm test` builds the strict TypeScript source and runs the Node.js test suite. Publishing also runs lint and tests through `prepublishOnly`.

## Credits

Originally forked from [calvarium/homebridge-http-garage-door](https://github.com/calvarium/homebridge-http-garage-door).

## License

[MIT](LICENSE)
