-- Read-only pilot export for the CCISS database owner. Not executed by PGMaps.
-- Supply a JSON array of 1–25 REAL siteno IDs, never coordinates or BGC codes.
-- Example invocation (replace the environment values with authorized settings):
-- psql "$CCISS_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 \
--   -v site_ids="$CCISS_SITE_IDS_JSON" -f export-current-pilot.sql > pilot.json
-- Table names follow the downloaded Shiny app. Confirm names/columns first.
-- This preserves arrays and explicit dimension order; it does not recompute ratings.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH requested AS (
  SELECT DISTINCT value::bigint AS siteno
  FROM jsonb_array_elements_text(:'site_ids'::jsonb)
  WHERE jsonb_array_length(:'site_ids'::jsonb) BETWEEN 1 AND 25
), dimensions AS (
  SELECT row_number() OVER (ORDER BY gcm_id, scenario_id, futureperiod_id, run_id) AS array_ordinal,
         gcm_id, scenario_id, futureperiod_id, run_id, gcm, scenario, futureperiod, run
  FROM gcm CROSS JOIN scenario CROSS JOIN futureperiod CROSS JOIN run
)
SELECT jsonb_build_object(
  'schema', 'cciss-current-pilot-v1',
  'exportedAt', current_timestamp,
  'requestedSites', :'site_ids'::jsonb,
  'requestValid', jsonb_array_length(:'site_ids'::jsonb) BETWEEN 1 AND 25,
  'dimensions', (SELECT jsonb_agg(to_jsonb(d) ORDER BY array_ordinal) FROM dimensions d),
  'bgcCodes', (SELECT jsonb_agg(to_jsonb(b) ORDER BY bgc_id) FROM bgc14 b),
  'future', (SELECT jsonb_agg(to_jsonb(f) ORDER BY siteno) FROM cciss_future14_array f JOIN requested USING (siteno)),
  'observed', (SELECT jsonb_agg(to_jsonb(c) ORDER BY siteno) FROM cciss_current14 c JOIN requested USING (siteno)),
  'novelty', (SELECT jsonb_agg(to_jsonb(n) ORDER BY siteno) FROM cciss_novelty14_array n JOIN requested USING (siteno)),
  'attribution', (SELECT jsonb_agg(to_jsonb(a) ORDER BY siteno) FROM bgc_attribution14 a JOIN requested USING (siteno)),
  'siteGeometry', (SELECT jsonb_agg(jsonb_build_object('siteno',h.siteno,'geometry',ST_AsGeoJSON(ST_Transform(h.geom,4326))::jsonb) ORDER BY h.siteno) FROM hex_grid h JOIN requested USING (siteno)),
  'arrayValidation', (SELECT jsonb_agg(jsonb_build_object('siteno',f.siteno,'bgcArrayLength',cardinality(f.bgc_id),'dimensionCount',(SELECT count(*) FROM dimensions),'noveltyArrayLength',cardinality(n.novelty)) ORDER BY f.siteno) FROM cciss_future14_array f JOIN requested USING (siteno) LEFT JOIN cciss_novelty14_array n USING (siteno)),
  'needsSeparateExport', jsonb_build_array('deployed ccissr package and tables','Shiny app commit and settings','dbPointInfo output for validation coordinates','authentic CSV/RDS result for the same sites and settings')
);
ROLLBACK;
