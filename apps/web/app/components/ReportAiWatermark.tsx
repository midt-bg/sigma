// D5: "AI-генерирано, неофициално" watermark rendered on every AI report (spec §9.12 / §D5).
// Always shown — the `watermark: 'ai-generated'` field on ResolvedReport is the gate.

/**
 * Prominent strip that labels the report as AI-generated and non-official.
 * Appears directly below the report title so it is visible before any data.
 */
export function ReportAiWatermark() {
  return (
    <div className="report-watermark" role="note" aria-label="Предупреждение за AI съдържание">
      <span className="report-watermark__badge" aria-hidden="true">
        AI
      </span>
      <p className="report-watermark__text">
        <strong>AI-генерирано, неофициално</strong> — справката е съставена автоматично от езиков
        модел върху данните на СИГМА. Не е официален документ. Проверявайте критични числа от
        първичен источник.
      </p>
    </div>
  );
}
