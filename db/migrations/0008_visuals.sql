-- 0008_visuals: ginger visual journey (T11). Additive only; extends visual_assets from 0001.
-- stage id lives in the existing stage_key column; source photo in the existing source_media_id column.
ALTER TABLE visual_assets
  ADD COLUMN kind text NOT NULL DEFAULT 'illustrative' CHECK (kind IN ('illustrative','schematic')),
  ADD COLUMN status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','failed','schematic')),
  ADD COLUMN illustrative boolean NOT NULL DEFAULT true CHECK (illustrative),
  ADD COLUMN evidence_state text NOT NULL DEFAULT 'illustrative' CHECK (evidence_state = 'illustrative'),
  ADD COLUMN crop_id text,
  ADD COLUMN provider text,
  ADD COLUMN provider_request_id text,
  ADD COLUMN prompt_version text,
  ADD COLUMN prompt_template_hash text,
  ADD COLUMN brief_hash text,
  ADD COLUMN qa jsonb,
  ADD COLUMN storage_key text,
  ADD COLUMN region_version integer,
  ADD COLUMN width integer,
  ADD COLUMN height integer,
  ADD COLUMN failure_reason text,
  ADD COLUMN reused_from uuid REFERENCES visual_assets(id) ON DELETE SET NULL;

-- A generated or schematic asset can never be labelled as an observation.
ALTER TABLE visual_assets ADD CONSTRAINT visual_assets_label_chk CHECK (label IN ('illustrative','schematic'));
-- Only a ready keyframe has a stored object; schematic rows never carry one.
ALTER TABLE visual_assets ADD CONSTRAINT visual_assets_storage_chk CHECK (
  (status = 'ready' AND storage_key IS NOT NULL AND kind = 'illustrative') OR (status <> 'ready' AND storage_key IS NULL));
ALTER TABLE visual_assets ADD CONSTRAINT visual_assets_schematic_kind_chk CHECK (status <> 'schematic' OR kind = 'schematic');

CREATE INDEX visual_assets_plan_stage_idx ON visual_assets(owner_id, plan_id, stage_key);

-- Cache keys are plan-independent (photo, region, crop, stages, brief, model, mode), so a revised or second plan can adopt
-- an existing keyframe without a provider call. Each plan still has its own row (provenance), sharing the stored object.
ALTER TABLE visual_assets DROP CONSTRAINT visual_assets_owner_id_cache_key_key;
ALTER TABLE visual_assets ADD CONSTRAINT visual_assets_owner_plan_cache_uq UNIQUE (owner_id, plan_id, cache_key);
CREATE INDEX visual_assets_owner_cache_idx ON visual_assets(owner_id, cache_key);
