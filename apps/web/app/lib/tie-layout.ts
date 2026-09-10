import type { CompanyTieEdge } from '@sigma/api-contract';

// The tie network laid out for drawing — boxes and routed edges, positioned on the server
// (tie-layout.server.ts) so the layout engine never reaches the browser. Plain data: it travels in the
// loader payload and TieGraph only draws it.

export interface TieLayoutNode {
  id: string;
  kind: 'company' | 'authority';
  /** The full name — for the accessible label and the tooltip. */
  name: string;
  /** The name as drawn in the box: whole when it fits the widest box, else cut with an ellipsis. */
  label: string;
  href: string;
  valueEur: number;
  center: boolean;
  /** Box centre and size, in the layout's own units. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TieLayoutEdge extends CompanyTieEdge {
  /** The routed line, from `from` to `to` in the tie's own direction (so an arrow sits at `to`). */
  points: { x: number; y: number }[];
  /** The kind of tie, written on the edge — centre point and the width reserved for it. */
  label: { text: string; x: number; y: number; width: number };
}

export interface TieLayout {
  width: number;
  height: number;
  centerName: string;
  nodes: TieLayoutNode[];
  edges: TieLayoutEdge[];
}
