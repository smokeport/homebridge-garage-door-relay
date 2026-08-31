import type { AccessoryConfig } from 'homebridge';

export type HttpMethod = 'GET' | 'POST';

export interface GarageDoorConfig extends AccessoryConfig {
  name: string;
  openURL: string;
  closeURL?: string;
  http_method?: string;
  openTime?: number;
  closeTime?: number;
  autoClose?: boolean;
  autoCloseDelay?: number;
  hasClosedSensor?: boolean;
  hasOpenSensor?: boolean;
  username?: string;
  password?: string;
  timeout?: number;
  webhookPort?: number;
  manufacturer?: string;
  model?: string;
  serial?: string | number;
  firmware?: string;
  verifyTls?: boolean;
  debug?: boolean;
}

export interface NormalizedGarageDoorConfig {
  name: string;
  openURL: string;
  closeURL?: string;
  httpMethod: HttpMethod;
  openTime: number;
  closeTime: number;
  autoClose: boolean;
  autoCloseDelay: number;
  hasClosedSensor: boolean;
  hasOpenSensor: boolean;
  username?: string;
  password?: string;
  timeout: number;
  webhookPort?: number;
  manufacturer: string;
  model: string;
  serial: string;
  firmware: string;
  verifyTls: boolean;
  debug: boolean;
}
