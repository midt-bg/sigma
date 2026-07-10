CASE
  WHEN eik_clean IS NULL OR eik_clean GLOB '*[^0-9]*' OR LENGTH(eik_clean) NOT IN (9, 13) THEN 0
  WHEN (
    CASE
      WHEN (1 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 2 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11 < 10 THEN (1 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 2 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11
      WHEN (3 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 10 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11 < 10 THEN (3 * CAST(SUBSTR(eik_clean, 1, 1) AS INTEGER) + 4 * CAST(SUBSTR(eik_clean, 2, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 3, 1) AS INTEGER) + 6 * CAST(SUBSTR(eik_clean, 4, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 5, 1) AS INTEGER) + 8 * CAST(SUBSTR(eik_clean, 6, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 7, 1) AS INTEGER) + 10 * CAST(SUBSTR(eik_clean, 8, 1) AS INTEGER)) % 11
      ELSE 0
    END
  ) <> CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) THEN 0
  WHEN LENGTH(eik_clean) = 9 THEN 1
  WHEN (
    CASE
      WHEN (2 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11 < 10 THEN (2 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 3 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11
      WHEN (4 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11 < 10 THEN (4 * CAST(SUBSTR(eik_clean, 9, 1) AS INTEGER) + 9 * CAST(SUBSTR(eik_clean, 10, 1) AS INTEGER) + 5 * CAST(SUBSTR(eik_clean, 11, 1) AS INTEGER) + 7 * CAST(SUBSTR(eik_clean, 12, 1) AS INTEGER)) % 11
      ELSE 0
    END
  ) = CAST(SUBSTR(eik_clean, 13, 1) AS INTEGER) THEN 1
  ELSE 0
END AS eik_valid
