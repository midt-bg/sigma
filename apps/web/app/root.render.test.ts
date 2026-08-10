// The nonce mismatch is created by ServerRouter's FrameworkContext, but reproducing that
// server/client split needs Router internals (a manifest and data-router state) rather than the
// app's rendering harness. Keep this regression test structural: it protects the two exact
// Layout props that make the server and client markup agree without coupling to those internals.
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// Read root.tsx as a raw string via Vite's `?raw` import (typed by vite/client) rather than node:fs —
// apps/web test files are typechecked under the Workers config (tsconfig.cloudflare.json), which has no
// Node types, so `node:fs`/`node:url` would not resolve.
import rootRaw from './root.tsx?raw';

const rootSource = ts.createSourceFile(
  'root.tsx',
  rootRaw,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const layout = rootSource.statements.find(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'Layout',
);

function layoutElements(tagName: string): ts.JsxOpeningLikeElement[] {
  const elements: ts.JsxOpeningLikeElement[] = [];
  const visit = (node: ts.Node) => {
    const element = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (element?.tagName.getText(rootSource) === tagName) {
      elements.push(element);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(layout!, visit);
  return elements;
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(rootSource) === name,
  );
}

describe('root Layout hydration guards', () => {
  it('passes an explicit empty nonce to Links', () => {
    const nonce = attribute(layoutElements('Links')[0]!, 'nonce');

    expect(layout).toBeDefined();
    expect(
      nonce?.initializer && ts.isStringLiteral(nonce.initializer) && nonce.initializer.text,
    ).toBe('');
  });

  it('suppresses hydration warnings on body attributes', () => {
    const suppressHydrationWarning = attribute(
      layoutElements('body')[0]!,
      'suppressHydrationWarning',
    );

    expect(layout).toBeDefined();
    expect(suppressHydrationWarning).toBeDefined();
    expect(suppressHydrationWarning?.initializer).toBeUndefined();
  });
});
