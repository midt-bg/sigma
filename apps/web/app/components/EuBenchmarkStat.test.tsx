import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EuBenchmarkStat } from './EuBenchmarkStat';

const props = {
  title: 'Една оферта',
  qualifier: 'от договорите с известен брой оферти са с една оферта',
  share: 1,
  good: 0.1,
  bad: 0.2,
  detail: '1 от 1 договора',
};

describe('EuBenchmarkStat', () => {
  it('fills the meter in the accent only for a verdict over the EU threshold', () => {
    const html = renderToStaticMarkup(
      <EuBenchmarkStat {...props} rating="bad" ratingLabel="над прага на ЕС" />,
    );
    expect(html).toContain('над прага на ЕС');
    expect(html).toContain('class="warn"');
  });

  it('shows a share without a verdict, and never in the accent, when there is none', () => {
    const html = renderToStaticMarkup(
      <EuBenchmarkStat
        {...props}
        rating={null}
        ratingLabel="твърде малко договори за сравнение с праговете на ЕС (под 20)"
      />,
    );
    expect(html).toContain('твърде малко договори');
    expect(html).not.toContain('над прага на ЕС');
    expect(html).not.toContain('class="warn"');
  });
});
