// --import shim: register the TS extension-resolution hook before the entry module loads.
import { register } from 'node:module';
register('./ts-ext.mjs', import.meta.url);
