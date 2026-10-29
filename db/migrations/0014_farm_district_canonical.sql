-- F12: farms store canonical registry ids (IN-XX, IN-XX-slug). Earlier web-created farms stored "typed:KA:hassan".
-- Keep the farmer-reported text (district_name, falling back to the legacy slug) and drop the non-canonical code so rule
-- scope and the assistant gate never see a made-up id. state_code "KA" is canonicalised to "IN-KA".
UPDATE farms
   SET district_name = COALESCE(NULLIF(btrim(district_name), ''), replace(regexp_replace(district_code, '^typed:[^:]*:', ''), '-', ' ')),
       district_code = NULL
 WHERE district_code IS NOT NULL
   AND district_code !~ '^IN-[A-Z]{2}(-[a-z0-9-]+)?$';

UPDATE farms
   SET state_code = 'IN-' || upper(state_code)
 WHERE state_code ~ '^[A-Za-z]{2}$';
