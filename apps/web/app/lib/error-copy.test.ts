import { describe, expect, it } from 'vitest';
import { errorCopy } from './error-copy';

// React Router hands the boundary a Response a loader threw as an ErrorResponse: this shape.
const thrown = (status: number) => ({ status, statusText: '', internal: false, data: null });

describe('errorCopy', () => {
  it('names a missing record as such', () => {
    expect(errorCopy(thrown(404))).toMatchObject({
      kicker: 'Грешка 404',
      title: 'Страницата не е намерена',
      documentTitle: 'Страницата не е намерена — СИГМА',
    });
  });

  it('tells the reader the site is busy for a moment, not broken, on a 503', () => {
    const copy = errorCopy(thrown(503));
    expect(copy.title).toBe('Сайтът е зает в момента');
    expect(copy.lede).toContain('Опитай пак след малко');
  });

  it('keeps the general message for any other failure', () => {
    expect(errorCopy(new Error('boom')).title).toBe('Възникна грешка');
    expect(errorCopy(thrown(500)).title).toBe('Възникна грешка');
  });
});
