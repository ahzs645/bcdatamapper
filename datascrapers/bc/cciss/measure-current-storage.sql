-- Read-only storage audit for the CCISS database owner; no prediction rows exported.
-- psql "$CCISS_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 \
--   -f measure-current-storage.sql > current-storage.json
-- Run against the deployed database. Results are database storage, NOT compressed
-- browser-download sizes. Row counts are planner estimates, not exact counts.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
WITH wanted(name) AS (
  VALUES ('cciss_future14_array'), ('cciss_current14'),
         ('cciss_novelty14_array'), ('bgc_attribution14'), ('bgc14'),
         ('gcm'), ('scenario'), ('futureperiod'), ('run'),
         ('hex_grid'), ('bc_elevation'), ('bec_info'), ('bcb_hres'),
         ('bc_forest_regions')
), relations AS (
  SELECT w.name AS requested_name, n.nspname AS schema_name,
         c.relname, c.oid, c.relkind, c.reltuples,
         CASE WHEN c.relkind IN ('r', 'm') THEN pg_table_size(c.oid) END AS table_bytes,
         CASE WHEN c.relkind IN ('r', 'm') THEN pg_indexes_size(c.oid) END AS index_bytes,
         CASE WHEN c.relkind IN ('r', 'm') THEN pg_total_relation_size(c.oid) END AS total_bytes
  FROM wanted w
  LEFT JOIN (
    pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
  ) ON c.relname = w.name
    AND c.relkind IN ('r', 'm', 'p', 'v', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
)
SELECT jsonb_build_object(
  'schema', 'cciss-storage-audit-v1',
  'measuredAt', current_timestamp,
  'tables', (SELECT jsonb_agg(jsonb_build_object(
    'requestedTable', requested_name, 'schema', schema_name,
    'relationKind', relkind, 'found', oid IS NOT NULL,
    'estimatedRows', CASE WHEN reltuples >= 0 THEN reltuples::bigint END,
    'tableAndToastBytes', table_bytes, 'indexBytes', index_bytes,
    'totalDatabaseBytes', total_bytes
  ) ORDER BY requested_name, schema_name) FROM relations),
  'measuredRelationBytes', (SELECT sum(total_bytes) FROM relations),
  'notes', jsonb_build_array(
    'Missing tables and views/foreign/partitioned parents have null sizes, not zero.',
    'If partitioned parents appear, measure their physical partitions separately.',
    'All matching schemas are listed; select the schemas used by the deployed app.',
    'Database bytes include physical storage overhead; browser-package size requires a real export and conversion.'
  )
);
ROLLBACK;
