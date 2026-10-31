-- Sentinel-2 NDVI per scene for a farm boundary (Today view, Stream B).
-- Rows are written only in live mode from Microsoft Planetary Computer reads; synthetic/replay never read or write them.
-- polygon_hash = sha256 of the method version plus the 4-decimal rounded field ring, so a redrawn boundary or a
-- method change produces new rows instead of reusing stale statistics. A past scene's statistics do not change.
-- field_stats / neighbourhood_stats hold the NdviStats contract (packages/contracts/src/ndvi.ts); neighbourhood is
-- NULL when the 1 km buffer could not be read. image_keys maps 'visual'/'ndvi' to owner-private storage keys
-- ndvi/{farm_id}/{item_id}/{kind}.png; the farm deletion procedure must collect them (see services/today/ndvi.ts).
-- ON DELETE CASCADE preserves the existing hard-delete privacy procedure.
CREATE TABLE ndvi_scene_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  polygon_hash text NOT NULL CHECK (polygon_hash ~ '^[0-9a-f]{64}$'),
  item_id text NOT NULL CHECK (item_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  acquired_at timestamptz NOT NULL,
  baseline text CHECK (baseline IS NULL OR baseline ~ '^[0-9]{1,2}\.[0-9]{2}$'),
  scene_cloud_pct double precision CHECK (scene_cloud_pct IS NULL OR scene_cloud_pct BETWEEN 0 AND 100),
  field_stats jsonb NOT NULL CHECK (jsonb_typeof(field_stats) = 'object'),
  neighbourhood_stats jsonb CHECK (neighbourhood_stats IS NULL OR jsonb_typeof(neighbourhood_stats) = 'object'),
  usable boolean NOT NULL,
  image_keys jsonb CHECK (image_keys IS NULL OR jsonb_typeof(image_keys) = 'object'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, polygon_hash, item_id)
);
CREATE INDEX ndvi_scene_stats_farm_acquired ON ndvi_scene_stats (farm_id, acquired_at DESC);
