import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import initialize from '../dist/index.js';
import { GarageDoorOpener } from '../dist/garageDoorOpener.js';
import { HttpClient } from '../dist/httpClient.js';

const temporaryDirectories = [];
const servers = [];

class FakeCharacteristic {
  value;
  setter;

  onSet(setter) {
    this.setter = setter;
    return this;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }
}

class FakeService {
  characteristics = new Map();

  constructor(name) {
    this.name = name;
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type)) {
      this.characteristics.set(type, new FakeCharacteristic());
    }
    return this.characteristics.get(type);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).updateValue(value);
    return this;
  }
}

const Characteristic = {
  CurrentDoorState: 'CurrentDoorState',
  TargetDoorState: 'TargetDoorState',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  FirmwareRevision: 'FirmwareRevision',
};

const Service = {
  GarageDoorOpener: class extends FakeService {},
  AccessoryInformation: class extends FakeService {},
};

const logger = {
  debug() {},
  error() {},
  info() {},
  log() {},
  success() {},
  warn() {},
  prefix: 'test',
};

function createApi(persistPath) {
  const listeners = new Map();
  return {
    hap: { Characteristic, Service },
    user: { persistPath: () => persistPath },
    on(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    listeners,
  };
}

function createTemporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-door-relay-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRelayServer() {
  const server = http.createServer((_request, response) => response.end('OK'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}/relay`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise(resolve => server.close(resolve));
  }
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test('registers the existing static accessory identifier', () => {
  let registration;
  initialize({
    on() {
      return this;
    },
    registerAccessory(name, constructor) {
      registration = { name, constructor };
    },
  });

  assert.equal(registration.name, 'GarageDoorOpener');
  assert.equal(registration.constructor, GarageDoorOpener);
});

test('restores the legacy state path and name-derived serial', () => {
  const persistPath = createTemporaryDirectory();
  fs.writeFileSync(
    path.join(persistPath, 'garage-door-state-back-door.json'),
    JSON.stringify({ current: 0 }),
  );
  const api = createApi(persistPath);
  const accessory = new GarageDoorOpener(logger, {
    accessory: 'GarageDoorOpener',
    name: 'Back door',
    openURL: 'http://192.0.2.10/open',
    closeURL: 'http://192.0.2.10/close',
    hasClosedSensor: true,
    hasOpenSensor: false,
  }, api);

  const [information, garageDoor] = accessory.getServices();
  assert.equal(information.getCharacteristic(Characteristic.SerialNumber).value, 'gd-back-door');
  assert.equal(garageDoor.getCharacteristic(Characteristic.CurrentDoorState).value, 0);
  assert.equal(garageDoor.getCharacteristic(Characteristic.TargetDoorState).value, 0);
});

test('opens through the modern onSet handler and simulates a missing open sensor', async () => {
  const persistPath = createTemporaryDirectory();
  const relayURL = await createRelayServer();
  const api = createApi(persistPath);
  const accessory = new GarageDoorOpener(logger, {
    accessory: 'GarageDoorOpener',
    name: 'Garage Door',
    openURL: relayURL,
    closeURL: relayURL,
    hasClosedSensor: true,
    hasOpenSensor: false,
    openTime: 0,
  }, api);
  const garageDoor = accessory.getServices()[1];
  const target = garageDoor.getCharacteristic(Characteristic.TargetDoorState);

  await target.setter(0);
  await delay(10);

  assert.equal(garageDoor.getCharacteristic(Characteristic.CurrentDoorState).value, 0);
  assert.equal(target.value, 0);
});


test('accepts the legacy disabled webhook sentinel in auto-close mode', () => {
  const persistPath = createTemporaryDirectory();
  const api = createApi(persistPath);

  assert.doesNotThrow(() => new GarageDoorOpener(logger, {
    accessory: 'GarageDoorOpener',
    name: 'Automatic Gate',
    openURL: 'http://192.0.2.10/open',
    autoClose: true,
    webhookPort: 0,
  }, api));
});

test('preserves an explicit numeric serial as HomeKit metadata', () => {
  const persistPath = createTemporaryDirectory();
  const api = createApi(persistPath);
  const accessory = new GarageDoorOpener(logger, {
    accessory: 'GarageDoorOpener',
    name: 'Numbered Door',
    openURL: 'http://192.0.2.10/open',
    closeURL: 'http://192.0.2.10/close',
    hasClosedSensor: true,
    serial: 12345,
  }, api);

  const information = accessory.getServices()[0];
  assert.equal(information.getCharacteristic(Characteristic.SerialNumber).value, '12345');
});

test('retains legacy background and duplicate sensor-edge behavior', () => {
  const persistPath = createTemporaryDirectory();
  fs.writeFileSync(
    path.join(persistPath, 'garage-door-state-sensor-door.json'),
    JSON.stringify({ current: 0 }),
  );
  const api = createApi(persistPath);
  const accessory = new GarageDoorOpener(logger, {
    accessory: 'GarageDoorOpener',
    name: 'Sensor Door',
    openURL: 'http://192.0.2.10/open',
    closeURL: 'http://192.0.2.10/close',
    hasClosedSensor: true,
    hasOpenSensor: true,
  }, api);
  const garageDoor = accessory.getServices()[1];

  accessory.handleWebhook({ open: 'false', background: 'true' });
  assert.equal(garageDoor.getCharacteristic(Characteristic.CurrentDoorState).value, 0);

  accessory.handleWebhook({ open: 'false' });
  const firstTimer = accessory.movementTimer;
  accessory.handleWebhook({ open: 'false' });
  assert.equal(accessory.movementTimer, firstTimer);
  accessory.shutdown();
});

test('rejects contradictory sensor webhook parameters', () => {
  const persistPath = createTemporaryDirectory();
  const api = createApi(persistPath);
  const accessory = new GarageDoorOpener(logger, {
    accessory: 'GarageDoorOpener',
    name: 'Webhook Door',
    openURL: 'http://192.0.2.10/open',
    closeURL: 'http://192.0.2.10/close',
    hasClosedSensor: true,
    hasOpenSensor: true,
  }, api);

  assert.throws(
    () => accessory.handleWebhook({ open: 'true', closed: 'false' }),
    /either open or closed/,
  );
});


test('follows legacy GET redirects to the relay destination', async () => {
  let destinationHits = 0;
  const destination = http.createServer((_request, response) => {
    destinationHits += 1;
    response.end('triggered');
  });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  servers.push(destination);
  const destinationAddress = destination.address();

  const redirect = http.createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${destinationAddress.port}/relay`,
    });
    response.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  servers.push(redirect);
  const redirectAddress = redirect.address();

  const client = new HttpClient({
    method: 'GET',
    timeout: 3_000,
    verifyTls: false,
  });
  await client.request(`http://127.0.0.1:${redirectAddress.port}/start`);

  assert.equal(destinationHits, 1);
});
