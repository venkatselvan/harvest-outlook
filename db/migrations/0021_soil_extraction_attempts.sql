ALTER TABLE soil_reports ADD COLUMN extraction_attempt integer NOT NULL DEFAULT 1 CHECK(extraction_attempt BETWEEN 1 AND 3);
CREATE TABLE soil_extraction_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),report_id uuid NOT NULL REFERENCES soil_reports(id) ON DELETE CASCADE,
 attempt integer NOT NULL,job_id uuid,status text NOT NULL,pages jsonb NOT NULL,extraction jsonb,invocation jsonb,warnings jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(report_id,attempt)
);
INSERT INTO soil_extraction_attempts(report_id,attempt,job_id,status,pages,extraction,invocation,warnings)
 SELECT id,1,job_id,status,pages,extraction,invocation,warnings FROM soil_reports WHERE extraction IS NOT NULL OR status IN ('error','unavailable');
