import type { PluginInitializer } from 'homebridge';

import { GarageDoorOpener } from './garageDoorOpener.js';
import { ACCESSORY_NAME } from './settings.js';

const initializer: PluginInitializer = api => {
  GarageDoorOpener.configureLifecycle(api);
  api.registerAccessory(ACCESSORY_NAME, GarageDoorOpener);
};

export default initializer;
