-- D28: add 'grounded' (excerpt machine-verified on the cited page; meaning/scope review pending) to every validation_status CHECK
-- that uses the ('validated','unsupported','pending','rejected') enum. Idempotent: constraints are found by definition.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%validation_status%'
       AND pg_get_constraintdef(c.oid) LIKE '%unsupported%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%grounded%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format($f$ALTER TABLE %s ADD CONSTRAINT %I CHECK (validation_status IN ('validated','grounded','unsupported','pending','rejected'))$f$, r.tbl, r.conname);
  END LOOP;
END $$;
