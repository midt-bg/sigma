import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Choropleth } from './Choropleth';

describe('Choropleth', () => {
  it('credits the boundaries wherever the map is drawn', () => {
    // GISCO's terms ask for the EuroGeographics notice next to the boundaries it supplies.
    const html = renderToStaticMarkup(<Choropleth regions={[]} />);
    expect(html).toContain('© EuroGeographics за административните граници');
  });

  it('shades the regions by spend and names each one with its amount', () => {
    const html = renderToStaticMarkup(
      <Choropleth
        regions={
          [
            { nuts3: 'BG411', name: 'Област Тест', valueEur: 5e6 },
            { nuts3: 'BG412', name: 'Област Проба', valueEur: 0 },
          ] as never
        }
      />,
    );
    expect(html).toContain('Област Тест: 5');
    expect(html).toContain('Област Проба');
  });
});
