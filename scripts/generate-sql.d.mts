export interface GeneratedTarget {
  template: string;
  output: string;
}

export const GENERATED_TARGETS: GeneratedTarget[];

export function expandTemplate(
  templateSql: string,
  options?: { baseDir?: string; templateName?: string },
): string;

export function generateAll(options?: {
  write?: boolean;
}): Array<GeneratedTarget & { outputPath: string; expanded: string }>;
