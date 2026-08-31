import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicValue,
  Logging,
  Service,
} from 'homebridge';

import { HttpClient } from './httpClient.js';
import { DEFAULT_MANUFACTURER, DEFAULT_MODEL } from './settings.js';
import type { GarageDoorConfig, HttpMethod, NormalizedGarageDoorConfig } from './types.js';
import { WebhookServer } from './webhookServer.js';
import type { WebhookParameters } from './webhookServer.js';

const CURRENT_STATE = {
  OPEN: 0,
  CLOSED: 1,
  OPENING: 2,
  CLOSING: 3,
  STOPPED: 4,
} as const;

const TARGET_STATE = {
  OPEN: 0,
  CLOSED: 1,
} as const;

type CurrentState = typeof CURRENT_STATE[keyof typeof CURRENT_STATE];
type TargetState = typeof TARGET_STATE[keyof typeof TARGET_STATE];

const packageVersion = (() => {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require('../package.json') as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '2.0.0';
  } catch {
    return '2.0.0';
  }
})();

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`GarageDoorOpener requires a non-empty "${field}" value`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalMetadata(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
    return String(value);
  }

  return undefined;
}

function booleanValue(value: unknown, defaultValue = false): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  return typeof value === 'boolean' ? value : defaultValue;
}

function numericValue(value: unknown, defaultValue: number, field: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? defaultValue);

  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`GarageDoorOpener "${field}" must be a number greater than or equal to ${minimum}`);
  }

  return parsed;
}

function normalizeConfig(input: AccessoryConfig): NormalizedGarageDoorConfig {
  const config = input as GarageDoorConfig;
  const name = requiredString(config.name, 'name');
  const openURL = requiredString(config.openURL, 'openURL');
  const autoClose = booleanValue(config.autoClose);
  const hasClosedSensor = booleanValue(config.hasClosedSensor);
  const hasOpenSensor = booleanValue(config.hasOpenSensor);
  const closeURL = optionalString(config.closeURL);
  const method = optionalString(config.http_method)?.toUpperCase() ?? 'GET';

  if (method !== 'GET' && method !== 'POST') {
    throw new Error('GarageDoorOpener "http_method" must be GET or POST');
  }

  if (autoClose) {
    if (hasClosedSensor || hasOpenSensor) {
      throw new Error('GarageDoorOpener auto-close mode cannot be combined with door sensors');
    }
  } else {
    if (!closeURL) {
      throw new Error('GarageDoorOpener requires "closeURL" when auto-close mode is disabled');
    }
    if (!hasClosedSensor && !hasOpenSensor) {
      throw new Error('GarageDoorOpener requires at least one door sensor when auto-close mode is disabled');
    }
  }

  let webhookPort: number | undefined;
  if (config.webhookPort !== undefined && config.webhookPort !== null) {
    const parsedWebhookPort = numericValue(config.webhookPort, 0, 'webhookPort');
    if (parsedWebhookPort !== 0) {
      webhookPort = parsedWebhookPort;
      if (!Number.isInteger(webhookPort) || webhookPort > 65_535) {
        throw new Error('GarageDoorOpener "webhookPort" must be zero or an integer between 1 and 65535');
      }
    }
  }

  if (autoClose && webhookPort !== undefined) {
    throw new Error('GarageDoorOpener auto-close mode cannot be combined with a webhook port');
  }

  const httpMethod: HttpMethod = method;

  return {
    name,
    openURL,
    closeURL,
    httpMethod,
    openTime: numericValue(config.openTime, 10, 'openTime'),
    closeTime: numericValue(config.closeTime, 10, 'closeTime'),
    autoClose,
    autoCloseDelay: numericValue(config.autoCloseDelay, 20, 'autoCloseDelay'),
    hasClosedSensor,
    hasOpenSensor,
    username: optionalString(config.username),
    password: optionalString(config.password),
    timeout: numericValue(config.timeout, 3_000, 'timeout', 1),
    webhookPort,
    manufacturer: optionalMetadata(config.manufacturer) ?? DEFAULT_MANUFACTURER,
    model: optionalMetadata(config.model) ?? DEFAULT_MODEL,
    serial: optionalMetadata(config.serial) ?? `gd-${slug(name)}`,
    firmware: optionalMetadata(config.firmware) ?? packageVersion,
    verifyTls: booleanValue(config.verifyTls),
    debug: booleanValue(config.debug),
  };
}

export class GarageDoorOpener implements AccessoryPlugin {
  private static readonly instances = new Set<GarageDoorOpener>();
  private static lifecycleConfigured = false;
  private static launched = false;

  static configureLifecycle(api: API): void {
    if (GarageDoorOpener.lifecycleConfigured) {
      return;
    }

    GarageDoorOpener.lifecycleConfigured = true;
    api.on('didFinishLaunching', () => {
      GarageDoorOpener.launched = true;
      for (const instance of GarageDoorOpener.instances) {
        instance.startWebhook();
      }
    });
    api.on('shutdown', () => {
      GarageDoorOpener.launched = false;
      for (const instance of GarageDoorOpener.instances) {
        instance.shutdown();
      }
      GarageDoorOpener.instances.clear();
    });
  }

  private readonly config: NormalizedGarageDoorConfig;
  private readonly garageDoorService: Service;
  private readonly informationService: Service;
  private readonly httpClient: HttpClient;
  private readonly webhookServer?: WebhookServer;
  private readonly stateFile: string;

  private currentState: CurrentState = CURRENT_STATE.CLOSED;
  private targetState: TargetState = TARGET_STATE.CLOSED;
  private movementTimer?: NodeJS.Timeout;
  private autoCloseTimer?: NodeJS.Timeout;
  private requestInFlight = false;
  private operationToken = 0;

  constructor(
    private readonly log: Logging,
    inputConfig: AccessoryConfig,
    private readonly api: API,
  ) {
    this.config = normalizeConfig(inputConfig);
    this.httpClient = new HttpClient({
      method: this.config.httpMethod,
      timeout: this.config.timeout,
      username: this.config.username,
      password: this.config.password,
      verifyTls: this.config.verifyTls,
    });

    this.stateFile = path.join(
      this.api.user.persistPath(),
      `garage-door-state-${slug(this.config.name)}.json`,
    );

    this.garageDoorService = new this.api.hap.Service.GarageDoorOpener(this.config.name);
    this.informationService = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.config.manufacturer)
      .setCharacteristic(this.api.hap.Characteristic.Model, this.config.model)
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.config.serial)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, this.config.firmware);

    this.restoreState();

    this.garageDoorService
      .getCharacteristic(this.api.hap.Characteristic.TargetDoorState)
      .onSet(value => this.setTargetDoorState(value));

    if (this.config.webhookPort !== undefined) {
      this.webhookServer = new WebhookServer(
        this.config.webhookPort,
        this.log,
        parameters => this.handleWebhook(parameters),
      );
    }

    GarageDoorOpener.instances.add(this);
    if (GarageDoorOpener.launched) {
      this.startWebhook();
    }

    this.debug(`Initialized with serial ${this.config.serial}`);
  }

  private startWebhook(): void {
    void this.webhookServer?.start().catch(error => {
      this.log.error(`Unable to start webhook server: ${this.errorMessage(error)}`);
    });
  }

  private shutdown(): void {
    this.clearAllTimers();
    void this.webhookServer?.stop().catch(error => {
      this.log.error(`Unable to stop webhook server: ${this.errorMessage(error)}`);
    });
  }

  identify(): void {
    this.log.info(`Identify requested for ${this.config.name}`);
  }

  getServices(): Service[] {
    return [this.informationService, this.garageDoorService];
  }

  private async setTargetDoorState(value: CharacteristicValue): Promise<void> {
    const requestedState = Number(value);

    if (requestedState === TARGET_STATE.OPEN) {
      if (this.currentState === CURRENT_STATE.OPEN || this.currentState === CURRENT_STATE.OPENING) {
        return;
      }
      await this.startOpening();
      return;
    }

    if (requestedState === TARGET_STATE.CLOSED) {
      if (this.config.autoClose) {
        if (this.currentState === CURRENT_STATE.CLOSED || this.currentState === CURRENT_STATE.CLOSING) {
          return;
        }
        this.clearAllTimers();
        this.startAutomaticClose();
        return;
      }

      if (this.currentState === CURRENT_STATE.CLOSED || this.currentState === CURRENT_STATE.CLOSING) {
        return;
      }
      await this.startClosing();
      return;
    }

    throw new Error(`Unsupported target door state: ${String(value)}`);
  }

  private async startOpening(): Promise<void> {
    this.clearAllTimers();
    const operationToken = this.beginOperation();
    this.setTargetState(TARGET_STATE.OPEN);
    this.setCurrentState(CURRENT_STATE.OPENING);

    try {
      await this.triggerRelay(this.config.openURL, 'open');
    } catch (error) {
      if (!this.isCurrentOperation(operationToken)) {
        return;
      }
      this.setTargetState(TARGET_STATE.CLOSED);
      this.setCurrentState(CURRENT_STATE.CLOSED);
      throw error;
    }

    if (!this.isCurrentOperation(operationToken)) {
      return;
    }

    if (this.config.hasOpenSensor) {
      this.scheduleMovementWatchdog(this.config.openTime);
    } else {
      this.scheduleMovement(this.config.openTime, () => {
        this.setCurrentState(CURRENT_STATE.OPEN);
      });
    }

    if (this.config.autoClose) {
      this.autoCloseTimer = setTimeout(() => {
        this.autoCloseTimer = undefined;
        this.startAutomaticClose();
      }, this.config.autoCloseDelay * 1_000);
    }
  }

  private async startClosing(): Promise<void> {
    const closeURL = this.config.closeURL;
    if (!closeURL) {
      throw new Error('Cannot close without a configured closeURL');
    }

    this.clearAllTimers();
    const operationToken = this.beginOperation();
    this.setTargetState(TARGET_STATE.CLOSED);
    this.setCurrentState(CURRENT_STATE.CLOSING);

    try {
      await this.triggerRelay(closeURL, 'close');
    } catch (error) {
      if (!this.isCurrentOperation(operationToken)) {
        return;
      }
      this.setTargetState(TARGET_STATE.OPEN);
      this.setCurrentState(CURRENT_STATE.OPEN);
      throw error;
    }

    if (!this.isCurrentOperation(operationToken)) {
      return;
    }

    if (this.config.hasClosedSensor) {
      this.scheduleMovementWatchdog(this.config.closeTime);
    } else {
      this.scheduleMovement(this.config.closeTime, () => {
        this.setCurrentState(CURRENT_STATE.CLOSED);
      });
    }
  }

  private startAutomaticClose(): void {
    this.beginOperation();
    this.clearMovementTimer();
    this.setTargetState(TARGET_STATE.CLOSED);
    this.setCurrentState(CURRENT_STATE.CLOSING);
    this.scheduleMovement(this.config.closeTime, () => {
      this.setCurrentState(CURRENT_STATE.CLOSED);
    });
  }

  private async triggerRelay(url: string, operation: 'open' | 'close'): Promise<void> {
    this.requestInFlight = true;
    this.debug(`Sending ${this.config.httpMethod} request to ${operation} the door`);

    try {
      await this.httpClient.request(url);
    } catch (error) {
      const wrappedError = new Error(`Unable to ${operation} ${this.config.name}: ${this.errorMessage(error)}`, { cause: error });
      this.log.error(wrappedError.message);
      throw wrappedError;
    } finally {
      this.requestInFlight = false;
    }
  }

  private handleWebhook(parameters: WebhookParameters): void {
    if (parameters.open !== undefined && parameters.closed !== undefined) {
      throw new Error('Webhook must contain either open or closed, not both');
    }

    const background = parameters.background === 'true';
    if (background && this.isOperationActive()) {
      this.debug('Ignoring background webhook while a door operation is active');
      return;
    }

    if (parameters.open !== undefined) {
      if (!this.config.hasOpenSensor) {
        this.log.warn('Ignoring open webhook because hasOpenSensor is disabled');
        return;
      }
      this.handleOpenSensor(parameters.open, background);
      return;
    }

    if (parameters.closed !== undefined) {
      if (!this.config.hasClosedSensor) {
        this.log.warn('Ignoring closed webhook because hasClosedSensor is disabled');
        return;
      }
      this.handleClosedSensor(parameters.closed, background);
      return;
    }

    this.log.warn('Ignoring webhook without an open or closed sensor value');
  }

  private handleOpenSensor(value: string, background: boolean): void {
    if (value === 'true') {
      this.beginOperation();
      this.clearMovementTimer();
      this.setTargetState(TARGET_STATE.OPEN);
      this.setCurrentState(CURRENT_STATE.OPEN);
      return;
    }

    if (value !== 'false') {
      this.log.warn(`Ignoring invalid open sensor value: ${value}`);
      return;
    }

    if (background) {
      if (!this.config.hasClosedSensor) {
        this.beginOperation();
        this.setTargetState(TARGET_STATE.CLOSED);
        this.setCurrentState(CURRENT_STATE.CLOSED);
      } else {
        this.debug('Ignoring background open=false because the closed sensor is authoritative');
      }
      return;
    }

    if (this.currentState === CURRENT_STATE.CLOSING) {
      this.debug('Ignoring duplicate open=false while the door is already closing');
      return;
    }

    this.beginOperation();
    this.clearMovementTimer();
    this.setTargetState(TARGET_STATE.CLOSED);
    this.setCurrentState(CURRENT_STATE.CLOSING);

    if (this.config.hasClosedSensor) {
      this.scheduleMovementWatchdog(this.config.closeTime);
    } else {
      this.scheduleMovement(this.config.closeTime, () => {
        this.setCurrentState(CURRENT_STATE.CLOSED);
      });
    }
  }

  private handleClosedSensor(value: string, background: boolean): void {
    if (value === 'true') {
      this.beginOperation();
      this.clearAllTimers();
      this.setTargetState(TARGET_STATE.CLOSED);
      this.setCurrentState(CURRENT_STATE.CLOSED);
      return;
    }

    if (value !== 'false') {
      this.log.warn(`Ignoring invalid closed sensor value: ${value}`);
      return;
    }

    if (background) {
      if (!this.config.hasOpenSensor) {
        this.beginOperation();
        this.setTargetState(TARGET_STATE.OPEN);
        this.setCurrentState(CURRENT_STATE.OPEN);
      } else {
        this.debug('Ignoring background closed=false because the open sensor is authoritative');
      }
      return;
    }

    if (this.currentState === CURRENT_STATE.OPENING) {
      this.debug('Ignoring duplicate closed=false while the door is already opening');
      return;
    }

    this.beginOperation();
    this.clearMovementTimer();
    this.setTargetState(TARGET_STATE.OPEN);
    this.setCurrentState(CURRENT_STATE.OPENING);

    if (this.config.hasOpenSensor) {
      this.scheduleMovementWatchdog(this.config.openTime);
    } else {
      this.scheduleMovement(this.config.openTime, () => {
        this.setCurrentState(CURRENT_STATE.OPEN);
      });
    }
  }

  private scheduleMovementWatchdog(expectedDuration: number): void {
    this.scheduleMovement(expectedDuration * 1.5, () => {
      this.log.warn(`${this.config.name} did not reach its expected end sensor`);
      this.setCurrentState(CURRENT_STATE.STOPPED);
    });
  }

  private scheduleMovement(seconds: number, callback: () => void): void {
    this.clearMovementTimer();
    this.movementTimer = setTimeout(() => {
      this.movementTimer = undefined;
      callback();
    }, seconds * 1_000);
  }

  private clearMovementTimer(): void {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
      this.movementTimer = undefined;
    }
  }

  private clearAllTimers(): void {
    this.clearMovementTimer();
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = undefined;
    }
  }

  private isOperationActive(): boolean {
    return this.requestInFlight || this.movementTimer !== undefined || this.autoCloseTimer !== undefined;
  }

  private restoreState(): void {
    const persistedState = this.config.autoClose ? CURRENT_STATE.CLOSED : this.readPersistedState();
    let restoredCurrent: CurrentState = persistedState;
    let restoredTarget: TargetState;

    switch (persistedState) {
    case CURRENT_STATE.OPEN:
      restoredTarget = TARGET_STATE.OPEN;
      break;
    case CURRENT_STATE.OPENING:
      restoredCurrent = CURRENT_STATE.STOPPED;
      restoredTarget = TARGET_STATE.OPEN;
      break;
    case CURRENT_STATE.CLOSING:
      restoredCurrent = CURRENT_STATE.STOPPED;
      restoredTarget = TARGET_STATE.CLOSED;
      break;
    case CURRENT_STATE.STOPPED:
      restoredTarget = TARGET_STATE.CLOSED;
      break;
    default:
      restoredTarget = TARGET_STATE.CLOSED;
      break;
    }

    this.currentState = restoredCurrent;
    this.targetState = restoredTarget;
    this.garageDoorService
      .getCharacteristic(this.api.hap.Characteristic.CurrentDoorState)
      .updateValue(restoredCurrent);
    this.garageDoorService
      .getCharacteristic(this.api.hap.Characteristic.TargetDoorState)
      .updateValue(restoredTarget);

    if (restoredCurrent !== persistedState) {
      this.persistState();
    }
  }

  private readPersistedState(): CurrentState {
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { current?: unknown };
      const state = Number(data.current);

      if (Object.values(CURRENT_STATE).includes(state as CurrentState)) {
        return state as CurrentState;
      }

      this.log.warn(`Ignoring invalid persisted state in ${this.stateFile}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn(`Unable to read persisted door state: ${this.errorMessage(error)}`);
      }
    }

    return CURRENT_STATE.CLOSED;
  }

  private persistState(): void {
    if (this.config.autoClose) {
      return;
    }

    try {
      fs.writeFileSync(this.stateFile, `${JSON.stringify({ current: this.currentState })}\n`, 'utf8');
    } catch (error) {
      this.log.warn(`Unable to persist door state: ${this.errorMessage(error)}`);
    }
  }

  private setCurrentState(state: CurrentState): void {
    this.currentState = state;
    this.garageDoorService
      .getCharacteristic(this.api.hap.Characteristic.CurrentDoorState)
      .updateValue(state);
    this.persistState();
    this.debug(`Current door state changed to ${state}`);
  }

  private setTargetState(state: TargetState): void {
    this.targetState = state;
    this.garageDoorService
      .getCharacteristic(this.api.hap.Characteristic.TargetDoorState)
      .updateValue(state);
    this.debug(`Target door state changed to ${state}`);
  }

  private debug(message: string): void {
    if (this.config.debug) {
      this.log.debug(message);
    }
  }

  private beginOperation(): number {
    this.operationToken += 1;
    return this.operationToken;
  }

  private isCurrentOperation(operationToken: number): boolean {
    return this.operationToken === operationToken;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
