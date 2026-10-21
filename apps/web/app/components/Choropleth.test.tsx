import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Choropleth } from './Choropleth';

describe('Choropleth', () => {
  it('credits the boundaries wherever the map is drawn', () => {
    // GISCO's terms ask for the EuroGeographics notice next to the boundaries it supplies.
    const html = renderToStaticMarkup(<Choropleth regions={[]} />);
    expect(html).toContain('© EuroGeographics за административните граници');
  });
});
