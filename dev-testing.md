# Development testing

This guide runs the plugin against a local Homebridge 2 development instance without installing it on a production Homebridge server or contacting a real garage-door relay.

The development instance uses:

- the Homebridge version installed locally by `npm ci`;
- a temporary Homebridge storage directory instead of `~/.homebridge`;
- this repository as the only plugin search path;
- loopback-only fake relay and webhook ports; and
- a unique development bridge identity and port.

## Prerequisites

Install the following on the development computer:

- Git;
- Node.js 22.12 or later from an even-numbered supported release (22, 24, or 26); and
- a terminal: Terminal on macOS or PowerShell on Windows.

Run all repository commands from the root of this project.

> [!CAUTION]
> Never put a real relay URL or production Homebridge storage path in this test configuration. The sample below uses only `127.0.0.1`, so it cannot operate the real door.

## Test configuration

Both platforms use the same isolated Homebridge configuration. Save the following JSON as `config.json` in the temporary directory created by the relevant platform instructions:

```json
{
  "bridge": {
    "name": "Garage Relay Dev",
    "username": "0E:12:34:56:78:90",
    "port": 51999,
    "pin": "031-45-154"
  },
  "accessories": [
    {
      "accessory": "GarageDoorOpener",
      "name": "Development Garage Door",
      "http_method": "GET",
      "openURL": "http://127.0.0.1:18080/open",
      "closeURL": "http://127.0.0.1:18080/close",
      "openTime": 2,
      "closeTime": 2,
      "autoClose": false,
      "hasClosedSensor": true,
      "hasOpenSensor": true,
      "webhookPort": 18081,
      "timeout": 3000,
      "debug": true
    }
  ]
}
```

The bridge username and bridge, relay, and webhook ports are intentionally different from normal Homebridge defaults.

## macOS

### 1. Install, build, and run the automated tests

```sh
npm ci
npm test
```

`npm test` compiles the TypeScript source and runs the migration and behavior tests before Homebridge is started.

### 2. Create isolated Homebridge storage

```sh
DEV_STORAGE="$(mktemp -d "${TMPDIR:-/tmp}/homebridge-garage-relay.XXXXXX")"
printf 'Development storage: %s\n' "$DEV_STORAGE"
nano "$DEV_STORAGE/config.json"
```

Paste the [test configuration](#test-configuration), save with Control+O, press Return, and exit nano with Control+X.

### 3. Start a fake relay

Open a second Terminal window and run:

```sh
node -e "require('node:http').createServer((req,res)=>{console.log(new Date().toISOString(),req.method,req.url);res.end('OK')}).listen(18080,'127.0.0.1',()=>console.log('Fake relay listening on http://127.0.0.1:18080'))"
```

Keep this process running. Any open or close request will be printed here rather than sent to real hardware.

### 4. Start the isolated Homebridge instance

Back in the original Terminal window, run:

```sh
./node_modules/.bin/homebridge \
  -D \
  -U "$DEV_STORAGE" \
  -P "$PWD" \
  --strict-plugin-resolution
```

Homebridge should load `GarageDoorOpener` and report that the webhook server is listening on port `18081`.

### 5. Send sensor updates

Open a third Terminal window and run:

```sh
curl "http://127.0.0.1:18081/?closed=false"
curl "http://127.0.0.1:18081/?open=true"
curl "http://127.0.0.1:18081/?open=false"
curl "http://127.0.0.1:18081/?closed=true"
```

The Homebridge debug log should show the door move through opening, open, closing, and closed states.

### 6. Stop and clean up

Stop Homebridge and the fake relay with Control+C. In the Terminal window where `DEV_STORAGE` is still defined, run:

```sh
test -n "$DEV_STORAGE" && rm -rf "$DEV_STORAGE"
```

## Windows

Use a regular PowerShell window; administrator access is not required.

### 1. Install, build, and run the automated tests

```powershell
npm.cmd ci
npm.cmd test
```

Using `npm.cmd` avoids PowerShell execution-policy errors that can occur when `npm.ps1` is selected.

### 2. Create isolated Homebridge storage

```powershell
$devStorage = Join-Path $env:TEMP "homebridge-garage-door-relay-dev"
New-Item -ItemType Directory -Force $devStorage | Out-Null
Write-Host "Development storage: $devStorage"
notepad (Join-Path $devStorage "config.json")
```

Paste the [test configuration](#test-configuration), save it, and close Notepad. Make sure Notepad does not append `.txt` to the filename.

### 3. Start a fake relay

Open a second PowerShell window and run:

```powershell
node -e "require('node:http').createServer((req,res)=>{console.log(new Date().toISOString(),req.method,req.url);res.end('OK')}).listen(18080,'127.0.0.1',()=>console.log('Fake relay listening on http://127.0.0.1:18080'))"
```

Keep this process running. It listens only on the local computer.

### 4. Start the isolated Homebridge instance

Back in the original PowerShell window, run:

```powershell
npx.cmd homebridge `
  -D `
  -U $devStorage `
  -P (Get-Location).Path `
  --strict-plugin-resolution
```

Homebridge should load `GarageDoorOpener` and report that the webhook server is listening on port `18081`.

If Windows Firewall prompts for Node.js network access, allow **Private networks only** when performing the optional iPhone pairing test. Command-line testing against `127.0.0.1` does not require public-network access.

### 5. Send sensor updates

Open a third PowerShell window and run:

```powershell
curl.exe "http://127.0.0.1:18081/?closed=false"
curl.exe "http://127.0.0.1:18081/?open=true"
curl.exe "http://127.0.0.1:18081/?open=false"
curl.exe "http://127.0.0.1:18081/?closed=true"
```

Use `curl.exe` explicitly because Windows PowerShell may map `curl` to `Invoke-WebRequest`.

### 6. Stop and clean up

Stop Homebridge and the fake relay with Control+C. In the PowerShell window where `$devStorage` is still defined, run:

```powershell
if ($devStorage -and (Test-Path $devStorage)) {
  Remove-Item -Recurse -Force $devStorage
}
```

## Optional end-to-end HomeKit test

The command-line procedure verifies plugin loading, configuration, state persistence, webhook processing, HTTP transport, and migration behavior. To test HomeKit commands as well:

1. Keep the isolated Homebridge instance and fake relay running.
2. Ensure the development computer and iPhone are on the same trusted network.
3. Create a separate temporary Home in Apple's Home app.
4. Pair the `Garage Relay Dev` bridge using the QR code or PIN shown by the development instance.
5. Open and close `Development Garage Door` in the Home app.
6. Confirm `/open` and `/close` requests appear in the fake relay terminal.
7. Remove the temporary Home when testing is complete.

Do not pair the development bridge into the production Home. The unique bridge username and isolated storage prevent it from reusing the production bridge's pairing or accessory cache.

## Testing an existing configuration safely

To check that an existing accessory configuration still parses after the migration:

1. Copy only that accessory's JSON object into the isolated `accessories` array.
2. Keep its existing `name`, `serial`, timing, sensor, and auto-close values.
3. Replace `openURL` and `closeURL` with the loopback fake-relay URLs above.
4. Change `webhookPort` if that port is already in use.
5. Never copy the production bridge identity or point `-U` at production storage.

Keeping the accessory name and serial in this isolated test checks the migration-sensitive metadata without touching the real Homebridge instance.

## Troubleshooting

- **`EADDRINUSE`**: another process is using port `51999`, `18080`, or `18081`. Stop it or change the corresponding port in all relevant commands and configuration fields.
- **Plugin not found**: confirm the command is running from the repository root and that `npm ci` and `npm test` completed successfully.
- **Invalid config**: validate that `config.json` contains plain JSON without comments or trailing commas.
- **No webhook response**: wait until Homebridge reports that the webhook server is listening, then retry the request.
- **No HomeKit discovery**: allow Node.js on the private network, make sure the phone and computer are on the same LAN, and check that multicast DNS is not blocked by a VPN or guest network.
