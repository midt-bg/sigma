import type { Locale } from '../locale';
import { bg } from './bg';
import { en } from './en';
import type { Messages } from './types';

export const MESSAGES: Record<Locale, Messages> = { bg, en };

export type { Messages };
